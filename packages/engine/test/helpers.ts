import { GameEngine } from '../src/game.js';
import { walkSpecFiles, walkSpecFilesWithPaths } from '../src/vfs.js';
import { nodeById, shortestPath } from '../src/graph.js';
import { objectiveNodeIds } from '../src/objectives.js';
import type { EngineEvent, MissionSpec } from '../src/types.js';

/** Shared headless test helpers: drive the engine exactly like the UI does. */

export function drain(engine: GameEngine, line: string): EngineEvent[] {
  return engine.submit(line);
}

/** Resolve zero-delay pendings without advancing the clock. */
export function settle(engine: GameEngine): void {
  engine.tick(0);
}

export { walkSpecFiles };

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

/**
 * Walk the graph to `target`: connect to the owned node that borders the next
 * lock, breach and solve each lock on the way (answer key). Mirrors what a
 * player does; works on chains and forks.
 */
export function breachTo(engine: GameEngine, spec: MissionSpec, target: string, avoid: (id: string) => boolean = () => false): void {
  for (let guard = 0; guard < 20 && engine.mode === 'mission'; guard++) {
    const m = engine.getState().mission!;
    const owned = new Set(m.nodes.filter((n) => n.status !== 'locked').map((n) => n.id));
    if (owned.has(target)) {
      if (m.currentNodeId !== target) drain(engine, `connect ${nodeById(spec, target)!.ip}`);
      return;
    }
    const path = shortestPath(spec, 'n0', target, (id) => !avoid(id) || owned.has(id));
    if (!path) return;
    const next = path.find((id) => !owned.has(id))!;
    const via = path[path.indexOf(next) - 1]!;
    if (m.currentNodeId !== via) drain(engine, `connect ${nodeById(spec, via)!.ip}`);
    drain(engine, `breach ${nodeById(spec, next)!.ip}`);
    settle(engine);
    solveLock(engine, spec);
    settle(engine);
  }
}

/** Scan, then visit every objective node (and only those paths), taking the objective. */
export function playMission(engine: GameEngine, spec: MissionSpec, opts: { wipeLogs?: boolean } = {}): void {
  drain(engine, 'scan');
  settle(engine);
  const obj = spec.objective;
  for (const goal of objectiveNodeIds(spec)) {
    if (engine.mode !== 'mission') return;
    breachTo(engine, spec, goal, (id) => !!nodeById(spec, id)?.vault);
    const node = nodeById(spec, goal)!;
    if (opts.wipeLogs !== false) {
      for (const { file, path } of walkSpecFilesWithPaths(node.root)) if (file.tag === 'log') drain(engine, `rm ${path}`);
    }
    for (const { file, path } of walkSpecFilesWithPaths(node.root)) {
      if (engine.mode !== 'mission' || engine.getState().mission!.objective.done) break;
      if (file.tag !== 'target') continue;
      drain(engine, `download ${path}`);
      tickWhile(engine, () => engine.getState().mission?.transfer != null);
    }
    if (obj.type === 'payload' && engine.mode === 'mission') {
      drain(engine, `upload ${obj.payloadName} ${obj.dir}`);
      tickWhile(engine, () => engine.getState().mission?.transfer != null);
    }
    settle(engine);
  }
}

export function collect(events: EngineEvent[], t: 'trace'): { value: number; delta: number }[] {
  return events.filter((e) => e.t === t).map((e) => e as { value: number; delta: number });
}
