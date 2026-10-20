import { CONFIG } from './config.js';
import { GameEngine } from './game.js';
import { generateFor } from './missions.js';
import { generateSafeTemplate } from './gen/v2.js';
import { starterLoadout } from './equipment.js';
import { nodeById, shortestPath } from './graph.js';
import { objectiveNodeIds } from './objectives.js';
import { TUTORIAL_STEPS } from './tutorial.js';
import type { Loadout, MissionDescriptor, MissionOutcome, MissionSpec } from './types.js';
import { walkSpecFilesWithPaths } from './vfs.js';

/**
 * Mission solvability gate (PRD §15, F10): every shipped mission must be
 * completable with margin. The oracle plays through the REAL engine — the
 * same submit/tick API the UI uses — with answers from the generator's key and
 * simulated operator think time, so validation exercises actual trace math,
 * graph adjacency, objectives and modifiers rather than a parallel model.
 */

export type Route = 'auto' | 'long' | 'hot';

export interface OracleOptions {
  /** Which side of a fork to take (chains ignore this). */
  route?: Route;
  loadout?: Loadout;
  /** Wrong answers submitted before the right one, on the first N locks. */
  mistakes?: number;
  /** Multiplies the think-time constants (1 = CONFIG.validate pacing). */
  thinkScale?: number;
  /** Also crack the vault and take optional loot. */
  greed?: boolean;
  /** Spend proxies/decoys sensibly (default true). */
  tools?: boolean;
  /** Wipe logs on visited nodes (default true). */
  wipeLogs?: boolean;
  practice?: boolean;
}

export interface SimResult {
  busted: boolean;
  outcome: MissionOutcome | 'incomplete';
  objectiveComplete: boolean;
  traceEnd: number;
  traceMax: number;
  stolen: number;
  required: number;
  activeSeconds: number;
  cash: number;
  vaultLooted: boolean;
  /** Seconds spent with a transfer running (oracle-measured). */
  transferSeconds: number;
}

const TICK = 0.1;

class Oracle {
  readonly engine = new GameEngine({ fast: true, now: () => 0 });
  private locks = 0;

  constructor(
    private spec: MissionSpec,
    private opts: Required<Omit<OracleOptions, 'loadout' | 'practice'>> & Pick<OracleOptions, 'loadout' | 'practice'>
  ) {}

  get live(): boolean {
    return this.engine.probe().mode === 'mission';
  }

  idle(seconds: number): void {
    const steps = Math.round((seconds * this.opts.thinkScale) / TICK);
    for (let i = 0; i < steps && this.live; i++) this.engine.tick(TICK);
  }

  transferSeconds = 0;

  settle(): void {
    for (let i = 0; i < 400 && this.live && this.engine.probe().busy; i++) {
      if (this.engine.probe().transferring) this.transferSeconds += TICK;
      this.engine.tick(TICK);
    }
  }

  say(cmd: string): void {
    if (!this.live) return;
    this.engine.submit(cmd);
    this.settle();
    this.panic();
  }

  /** Burn a proxy when the meter gets scary. */
  panic(): void {
    if (!this.opts.tools || !this.live) return;
    const p = this.engine.probe();
    if (p.trace >= CONFIG.escalation.alertAt && p.tools.proxy > 0) this.engine.submit('proxy');
  }

  breach(nodeId: string): void {
    const node = nodeById(this.spec, nodeId)!;
    const p = this.engine.probe();
    if (this.opts.tools && p.watchdogNodeId === nodeId && !p.decoyActive && p.tools.decoy > 0) this.say('decoy');
    this.say(`breach ${node.ip}`);
    if (this.engine.probe().lockNodeId !== nodeId) return;
    this.idle(CONFIG.validate.secondsPerBreach);
    const ans = this.spec.puzzleAnswers[nodeId]!;
    if (this.locks++ < this.opts.mistakes && this.live && this.engine.probe().lockNodeId === nodeId) {
      this.say(ans.family === 'portknock' ? `knock ${ans.ports.map((x) => x + 1).join(' ')}` : ans.family === 'cipher' ? 'input WRONG' : `input ${ans.answer + 1}`);
      this.idle(CONFIG.validate.secondsPerMisc);
    }
    if (!this.live || this.engine.probe().lockNodeId !== nodeId) return;
    this.say(ans.family === 'portknock' ? `knock ${ans.ports.join(' ')}` : ans.family === 'cipher' ? `input ${ans.word}` : `input ${ans.answer}`);
  }

  /** Move onto `target`, breaching whatever lies on the way. */
  reach(target: string, allowed: (id: string) => boolean): boolean {
    const p = this.engine.probe();
    if (p.currentNodeId === target) return true;
    const owned = p.breached;
    // Start from the owned node closest to the first locked node on the path.
    let best: string[] | null = null;
    for (const from of owned) {
      const path = shortestPath(this.spec, from, target, (id) => owned.has(id) || allowed(id));
      if (!path) continue;
      const tail = path.slice(path.findIndex((id) => !owned.has(id)) - 1);
      const cand = path.every((id) => owned.has(id)) ? [target] : tail;
      if (!best || cand.length < best.length) best = cand;
    }
    if (!best) return false;
    const start = best[0]!;
    if (owned.has(start) && start !== this.engine.probe().currentNodeId) {
      this.idle(CONFIG.validate.secondsPerMisc);
      this.say(`connect ${nodeById(this.spec, start)!.ip}`);
    }
    for (const id of best.slice(1)) {
      if (!this.live) return false;
      if (this.engine.probe().breached.has(id)) {
        this.say(`connect ${nodeById(this.spec, id)!.ip}`);
        continue;
      }
      this.breach(id);
      if (!this.engine.probe().breached.has(id)) {
        // Fuse burned or busted: one more go, then give up.
        if (!this.live) return false;
        this.breach(id);
        if (!this.engine.probe().breached.has(id)) return false;
      }
      this.wipe();
    }
    return this.engine.probe().currentNodeId === target;
  }

  /** Work the current node: wipe logs, take objective files / plant payload, optional greed. */
  private wiped = new Set<string>();

  wipe(): void {
    const id = this.engine.probe().currentNodeId!;
    if (!this.opts.wipeLogs || this.wiped.has(id)) return;
    this.wiped.add(id);
    for (const { file, path } of walkSpecFilesWithPaths(nodeById(this.spec, id)!.root)) {
      if (!this.live) return;
      if (file.tag === 'log') {
        this.idle(CONFIG.validate.secondsPerMisc);
        this.say(`rm ${path}`);
      }
    }
  }

  work(): void {
    const id = this.engine.probe().currentNodeId!;
    const node = nodeById(this.spec, id)!;
    const obj = this.spec.objective;
    this.wipe();
    for (const { file, path } of walkSpecFilesWithPaths(node.root)) {
      if (!this.live) return;
      const wanted =
        file.tag === 'target' &&
        !!file.targetId &&
        ((obj.type === 'flagged' && obj.targetIds.includes(file.targetId)) || (obj.type === 'dossier' && obj.targetId === file.targetId));
      const greedy = this.opts.greed && file.tag === 'loot';
      if (!wanted && !greedy) continue;
      if (wanted && obj.type === 'flagged' && this.engine.probe().objectiveDone) continue;
      this.idle(CONFIG.validate.secondsPerDownload);
      this.say(`download ${path}`);
    }
    if (obj.type === 'payload' && obj.nodeId === id && !this.engine.probe().objectiveDone) {
      this.idle(CONFIG.validate.secondsPerDownload);
      this.say(`upload ${obj.payloadName} ${obj.dir}`);
    }
  }

  run(): void {
    const spec = this.spec;
    this.say('scan');
    this.idle(CONFIG.validate.secondsPerMisc);
    const route = this.opts.route;
    const avoid = route === 'long' ? 'hot' : route === 'hot' ? 'long' : null;
    const strict = (id: string) => {
      const n = nodeById(spec, id)!;
      return (this.opts.greed || !n.vault) && (!avoid || n.route !== avoid);
    };
    const loose = (id: string) => this.opts.greed || !nodeById(spec, id)!.vault;
    const goals = objectiveNodeIds(spec);
    const visited = new Set<string>();
    while (this.live && !this.engine.probe().objectiveDone) {
      const from = this.engine.probe().currentNodeId!;
      const next = goals
        .filter((g) => !visited.has(g))
        .map((g) => ({ g, len: shortestPath(spec, from, g, strict)?.length ?? 99 }))
        .sort((a, b) => a.len - b.len)[0];
      if (!next) break;
      visited.add(next.g);
      if (!this.reach(next.g, strict) && !this.reach(next.g, loose)) break;
      this.work();
    }
    if (this.opts.greed && this.live) {
      const vault = spec.nodes.find((n) => n.vault);
      if (vault && this.reach(vault.id, () => true)) this.work();
    }
    if (!this.live) return;
    const p = this.engine.probe();
    if (this.opts.tools && p.trace >= CONFIG.trace.cleanExitUnder && p.tools.proxy > 0) this.say('proxy');
    this.say('disconnect');
  }

  result(): SimResult {
    // Let a bust cutscene finish so the result is presented.
    for (let i = 0; i < 200 && this.engine.probe().mode === 'mission'; i++) this.engine.tick(0.5);
    const res = this.engine.lastResult;
    if (!res) {
      const p = this.engine.probe();
      return {
        busted: true,
        outcome: 'incomplete',
        objectiveComplete: false,
        traceEnd: p.trace,
        traceMax: p.peakTrace,
        stolen: 0,
        required: 0,
        activeSeconds: 0,
        cash: 0,
        vaultLooted: false,
        transferSeconds: this.transferSeconds,
      };
    }
    return {
      busted: res.outcome === 'busted',
      outcome: res.outcome,
      objectiveComplete: res.objectiveComplete,
      traceEnd: res.traceExact,
      traceMax: Math.max(res.peakTrace, res.traceExact),
      stolen: res.filesStolen,
      required: res.filesRequired,
      activeSeconds: res.activeSeconds,
      cash: res.cash,
      vaultLooted: res.vaultLooted,
      transferSeconds: Math.round(this.transferSeconds * 10) / 10,
    };
  }
}

/** The tutorial is gated step-by-step, so the perfect run follows the script. */
function playTutorial(spec: MissionSpec): SimResult {
  const engine = new GameEngine({ fast: true, now: () => 0 });
  engine.submit('skip');
  engine.startMission(spec);
  for (const step of TUTORIAL_STEPS) {
    if (engine.probe().mode !== 'mission') break;
    engine.submit(step.cmd.join(' '));
    for (let k = 0; k < 100 && engine.probe().busy; k++) engine.tick(TICK);
  }
  const res = engine.lastResult;
  return {
    busted: !res || res.outcome === 'busted',
    outcome: res?.outcome ?? 'incomplete',
    objectiveComplete: !!res?.objectiveComplete,
    traceEnd: res?.traceExact ?? 100,
    traceMax: res?.peakTrace ?? 100,
    stolen: res?.filesStolen ?? 0,
    required: res?.filesRequired ?? spec.requiredTargets,
    activeSeconds: res?.activeSeconds ?? 0,
    cash: res?.cash ?? 0,
    vaultLooted: false,
    transferSeconds: 0,
  };
}

/** Play one run of `spec` with an operator policy through the real engine. */
export function playOracle(spec: MissionSpec, options: OracleOptions = {}): SimResult {
  if (spec.kind === 'tutorial') return playTutorial(spec);
  const opts = {
    route: options.route ?? 'auto',
    mistakes: options.mistakes ?? 0,
    thinkScale: options.thinkScale ?? 1,
    greed: options.greed ?? false,
    tools: options.tools ?? true,
    wipeLogs: options.wipeLogs ?? true,
    loadout: options.loadout,
    practice: options.practice,
  };
  const o = new Oracle(spec, opts);
  o.engine.submit('skip');
  o.engine.startMission(spec, undefined, { loadout: opts.loadout ?? starterLoadout(), practice: opts.practice });
  o.run();
  return o.result();
}

/** Back-compat name used by older tests: the standard oracle on the auto route. */
export function simulatePerfectRun(spec: MissionSpec): SimResult {
  return playOracle(spec);
}

/** Routes the validator must prove: both sides of every fork. */
export function routesFor(spec: MissionSpec): Route[] {
  return spec.nodes.some((n) => n.route === 'hot') && spec.nodes.some((n) => n.route === 'long') ? ['long', 'hot'] : ['auto'];
}

export function passes(spec: MissionSpec, sim: SimResult): boolean {
  if (sim.busted || !sim.objectiveComplete) return false;
  if (sim.traceMax >= CONFIG.escalation.bustedAt || sim.traceEnd > CONFIG.validate.maxTrace) return false;
  const tier = spec.descriptor.mode === 'tutorial' ? 0 : spec.descriptor.tier;
  return tier > CONFIG.validate.cleanExitRequiredThrough || sim.outcome === 'clean';
}

/** Every required route of `spec` passes with the stock rig. */
export function validateSpec(spec: MissionSpec): { ok: boolean; sims: SimResult[] } {
  const sims: SimResult[] = [];
  for (const route of routesFor(spec)) {
    const sim = playOracle(spec, { route, loadout: starterLoadout() });
    sims.push(sim);
    if (!passes(spec, sim)) return { ok: false, sims };
  }
  return { ok: true, sims };
}

export class MissionUnavailableError extends Error {
  constructor(public readonly descriptor: MissionDescriptor) {
    super('no solvable network could be drawn for this job');
    this.name = 'MissionUnavailableError';
  }
}

export interface BuildHooks {
  generate?: (desc: MissionDescriptor, drawSeed: string, relax: number) => MissionSpec;
  check?: (spec: MissionSpec) => boolean;
  safeTemplate?: (desc: MissionDescriptor) => MissionSpec;
}

/** The deterministic sequence of (draw seed, relax) candidates for a descriptor. */
export function drawSchedule(desc: MissionDescriptor): { seed: string; relax: number }[] {
  const out: { seed: string; relax: number }[] = [];
  if (desc.gen === 1) {
    // Generation 1's frozen schedule: 30 straight, 2×15 relaxed, then a final relaxed draw.
    for (let a = 0; a < 30; a++) out.push({ seed: a === 0 ? desc.seed : `${desc.seed}~${a}`, relax: 0 });
    for (let r = 1; r <= 2; r++) for (let a = 0; a < 15; a++) out.push({ seed: `${desc.seed}~x${r}~${a}`, relax: r });
    out.push({ seed: `${desc.seed}~x2~final`, relax: 2 });
    return out;
  }
  for (let a = 0; a < CONFIG.validate.redraws; a++) out.push({ seed: a === 0 ? desc.seed : `${desc.seed}~${a}`, relax: 0 });
  for (let r = 1; r <= 2; r++) for (let a = 0; a < CONFIG.validate.relaxedDraws; a++) out.push({ seed: `${desc.seed}~x${r}~${a}`, relax: r });
  return out;
}

/**
 * Build a mission that is proven solvable: walk the deterministic draw
 * schedule, then a validated safe template. Same descriptor → same result,
 * always. Throws MissionUnavailableError rather than shipping an unproven job.
 */
export function buildValidatedMission(desc: MissionDescriptor, hooks: BuildHooks = {}): MissionSpec {
  const generate = hooks.generate ?? generateFor;
  const check = hooks.check ?? ((s: MissionSpec) => validateSpec(s).ok);
  for (const draw of drawSchedule(desc)) {
    const spec = generate(desc, draw.seed, draw.relax);
    if (check(spec)) return spec;
  }
  if (desc.gen === 1) {
    // Generation 1 always shipped its final relaxed draw; keep that identity.
    throw new MissionUnavailableError(desc);
  }
  const safe = (hooks.safeTemplate ?? generateSafeTemplate)(desc);
  if (check(safe)) return safe;
  throw new MissionUnavailableError(desc);
}
