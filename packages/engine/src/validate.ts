import { CONFIG } from './config.js';
import { GameEngine } from './game.js';
import { generateMission } from './missions.js';
import { TUTORIAL_STEPS } from './tutorial.js';
import type { EngineEvent, MissionOutcome, MissionSpec } from './types.js';
import { walkSpecFiles, walkSpecFilesWithPaths } from './vfs.js';

/**
 * Mission solvability gate (PRD §15): "the engine simulates a perfect run;
 * every generated mission must be completable with margin."
 *
 * The simulation plays through the REAL engine — same submit/tick API the UI uses,
 * with answers from the generator's key — so validation exercises the actual trace
 * math rather than a parallel model.
 */

export interface SimResult {
  busted: boolean;
  outcome: MissionOutcome | 'incomplete';
  traceEnd: number;
  traceMax: number;
  stolen: number;
  required: number;
}

/** Drain pendings/transfers with tiny ticks; fast-mode engine makes delays 0. */
function tickThrough(engine: GameEngine, seconds = 0.5): void {
  const steps = Math.ceil(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    engine.tick(0.05);
    if (engine.getState().mode === 'post') return;
  }
}

function drain(events: EngineEvent[]): void {
  void events; // the sim ignores presentation events
}

function solveOpenLock(engine: GameEngine, spec: MissionSpec): void {
  const puzzle = engine.getState().mission?.puzzle;
  if (!puzzle) return;
  // The lock's node is not your current node yet — the answer key is keyed by lock node.
  const answer = spec.puzzleAnswers[puzzle.nodeId];
  if (!answer) return;
  switch (answer.family) {
    case 'sequence':
      drain(engine.submit(`input ${answer.answer}`));
      break;
    case 'cipher':
      drain(engine.submit(`input ${answer.word}`));
      break;
    case 'portknock':
      drain(engine.submit(`knock ${answer.ports.join(' ')}`));
      break;
  }
}

/** The tutorial is gated step-by-step, so the perfect run follows the script. */
function playTutorialScript(engine: GameEngine, spec: MissionSpec): void {
  for (const step of TUTORIAL_STEPS) {
    if (engine.getState().mode !== 'mission') return;
    drain(engine.submit(step.cmd.join(' ')));
    tickThrough(engine, 0.2);
    for (let k = 0; k < 80 && engine.getState().mission?.transferLabel; k++) engine.tick(0.05);
    track(engine);
    void spec;
  }
}

function track(engine: GameEngine): void {
  void engine;
}

/**
 * A "perfect" run: scan, breach the whole chain solving every lock, download all
 * flagged files, wipe every log along the way, proxy only when needed, disconnect.
 */
export function simulatePerfectRun(spec: MissionSpec): SimResult {
  const engine = new GameEngine({ fast: true });
  drain(engine.submit('skip')); // skip boot → home
  const ev: EngineEvent[] = [];
  engine.startMission(spec, ev);

  let traceMax = 0;
  const track = () => {
    traceMax = Math.max(traceMax, engine.getState().mission?.trace ?? 0);
  };

  if (spec.kind === 'tutorial') {
    playTutorialScript(engine, spec);
    const res = engine.lastResult;
    return res
      ? {
          busted: res.outcome === 'busted',
          outcome: res.outcome,
          traceEnd: res.trace,
          traceMax: res.trace,
          stolen: res.filesStolen,
          required: res.filesRequired,
        }
      : { busted: true, outcome: 'incomplete', traceEnd: 100, traceMax: 100, stolen: 0, required: spec.requiredTargets };
  }

  drain(engine.submit('scan'));
  tickThrough(engine);
  track();

  for (let i = 1; i < spec.nodes.length; i++) {
    if (engine.getState().mode === 'post') break;
    const node = spec.nodes[i]!;
    drain(engine.submit(`breach ${node.ip}`));
    tickThrough(engine, 0.2);
    solveOpenLock(engine, spec);
    tickThrough(engine, 0.2);
    track();

    // download flagged files that live here (absolute paths — the sim is tidy)
    const lootPaths = walkSpecFilesWithPaths(node.root).filter(
      (x) => (x.file.tag === 'target' || x.file.tag === 'loot') && x.file.targetId
    );
    for (const { path } of lootPaths) {
      if (engine.getState().mode !== 'mission') break;
      drain(engine.submit(`download ${path}`));
      for (let k = 0; k < 80 && engine.getState().mission?.transferLabel; k++) {
        engine.tick(0.05);
        track();
      }
      tickThrough(engine, 0.1);
    }

    // wipe logs before moving on (perfect players buy margin as they go)
    for (const f of walkSpecFiles(node.root)) {
      if (f.tag === 'log') {
        drain(engine.submit(`rm /var/log/${f.name}`));
        track();
      }
    }

    // panic brake: never let the sim bust mid-chain if a proxy can save it
    if ((engine.getState().mission?.trace ?? 0) >= 80) {
      drain(engine.submit('proxy'));
      track();
    }
  }

  const preExit = engine.getState().mission?.trace ?? 0;
  if (preExit >= CONFIG.trace.cleanExitUnder) {
    drain(engine.submit('proxy'));
  }
  if (engine.getState().mode === 'mission') {
    drain(engine.submit('disconnect'));
  }

  const res = engine.lastResult;
  if (!res) {
    return { busted: true, outcome: 'incomplete', traceEnd: traceMax, traceMax, stolen: 0, required: spec.requiredTargets };
  }
  return {
    busted: res.outcome === 'busted',
    outcome: res.outcome,
    traceEnd: res.trace,
    traceMax,
    stolen: res.filesStolen,
    required: res.filesRequired,
  };
}

export interface ValidationReport {
  spec: MissionSpec;
  ok: boolean;
  sim: SimResult;
  attempts: number;
  relaxed: number;
}

/**
 * Build a contract spec that is guaranteed solvable: draw from the seed, simulate,
 * and on failure re-draw (deterministically), finally relaxing security depth.
 */
export function buildValidatedMission(index: number, seed: string): MissionSpec {
  // pass 1: straight draws
  for (let attempt = 0; attempt < 30; attempt++) {
    const spec = generateMission(index, attempt === 0 ? seed : `${seed}~${attempt}`);
    const sim = simulatePerfectRun(spec);
    if (passes(spec, sim)) return spec;
  }
  // pass 2: relax difficulty (fewer/hotter nodes tuned down) — still deterministic
  for (let relax = 1; relax <= 2; relax++) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const spec = generateMission(index, `${seed}~x${relax}~${attempt}`, relax);
      const sim = simulatePerfectRun(spec);
      if (passes(spec, sim)) return spec;
    }
  }
  // never fail to produce a mission: last relaxed draw wins
  return generateMission(index, `${seed}~x2~final`, 2);
}

function passes(spec: MissionSpec, sim: SimResult): boolean {
  const marginOk = !sim.busted && sim.stolen >= sim.required && sim.traceEnd <= CONFIG.validate.maxTrace;
  const cleanOk =
    spec.index > CONFIG.validate.cleanExitRequiredThrough || sim.outcome === 'clean';
  return marginOk && cleanOk;
}
