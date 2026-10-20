import { GameEngine } from '../src/game.js';
import { walkSpecFiles } from '../src/vfs.js';
import type { EngineEvent, MissionSpec } from '../src/types.js';

/** Shared headless test helpers: drive the engine exactly like the UI does. */

export function drain(engine: GameEngine, line: string): EngineEvent[] {
  return engine.submit(line);
}

/** Resolve zero-delay pendings without advancing the clock. */
export function settle(engine: GameEngine): void {
  engine.tick(0);
}

/** Run transfer/pending to completion with small ticks. */
export function tickWhile(engine: GameEngine, cond: () => boolean, maxSteps = 400): void {
  for (let i = 0; i < maxSteps && cond(); i++) {
    engine.tick(0.05);
  }
}

export function bootToHome(engine: GameEngine): void {
  drain(engine, 'skip');
  if (engine.mode === 'boot') engine.tick(10);
}

export function traceOf(engine: GameEngine): number {
  return engine.getState().mission?.trace ?? 0;
}

/** Solve the currently open lock using the generator answer key. */
export function solveLock(engine: GameEngine, spec: MissionSpec): void {
  const puzzle = engine.getState().mission!.puzzle;
  if (!puzzle) return;
  const answer = spec.puzzleAnswers[puzzle.nodeId]!;
  switch (answer.family) {
    case 'sequence':
      drain(engine, `input ${answer.answer}`);
      break;
    case 'cipher':
      drain(engine, `input ${answer.word}`);
      break;
    case 'portknock':
      drain(engine, `knock ${answer.ports.join(' ')}`);
      break;
  }
}

/** Scan, breach and fully loot the chain in the order the spec lays out. */
export function playMission(engine: GameEngine, spec: MissionSpec, opts: { wipeLogs?: boolean } = {}): void {
  drain(engine, 'scan');
  settle(engine);
  for (let i = 1; i < spec.nodes.length; i++) {
    if (engine.mode !== 'mission') return;
    const node = spec.nodes[i]!;
    drain(engine, `breach ${node.ip}`);
    settle(engine);
    solveLock(engine, spec);
    settle(engine);
    // download every flagged file on this node
    for (let pass = 0; pass < 4; pass++) {
      const snap = engine.getState().mission!;
      const here = snap.targets.filter((t) => t.nodeId === node.id && !t.stolen);
      if (!here.length) break;
      drain(engine, `download ${here[0]!.name}`);
      tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    }
    if (opts.wipeLogs !== false) {
      for (const f of walkSpecFiles(node.root)) {
        if (f.tag === 'log') drain(engine, `rm /var/log/${f.name}`);
      }
    }
    settle(engine);
  }
}

export function collect(events: EngineEvent[], t: 'trace'): { value: number; delta: number }[] {
  return events.filter((e) => e.t === t).map((e) => e as { value: number; delta: number });
}
