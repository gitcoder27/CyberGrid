import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { GameEngine } from '../src/game.js';
import { campaignDescriptor, customDescriptor, dailyDescriptor, encodeShareCode } from '../src/identity.js';
import { effectiveFor, unlocksBetween } from '../src/equipment.js';
import { compareRecords, recordRun, emptyRecords, scoreRun } from '../src/results.js';
import { nodeById } from '../src/graph.js';
import { runSimulation, simulationCorpus } from '../src/simulate.js';
import { playOracle } from '../src/validate.js';
import { walkSpecFilesWithPaths } from '../src/vfs.js';
import type { EngineEvent, MissionDescriptor, MissionSpec, RecordEntry } from '../src/types.js';
import { bootToHome, breachTo, drain, playMission, settle, tickWhile, traceOf } from './helpers.js';

const texts = (ev: EngineEvent[]) => ev.filter((e) => e.t === 'print').map((e) => (e as { text: string }).text).join('\n');
const DAY = 24 * 3600 * 1000;

function engineAt(contractsDone: number, xp = 0, now?: () => number): GameEngine {
  const engine = new GameEngine({
    fast: true,
    now,
    save: { version: 2, profile: { cash: 3000, xp, contractsDone, tutorialDone: true }, settings: {}, history: [], session: null },
  });
  bootToHome(engine);
  return engine;
}

function currentSpec(engine: GameEngine): MissionSpec {
  return (engine as unknown as { rt: { spec: MissionSpec } }).rt.spec;
}

function reload(engine: GameEngine, now?: () => number): GameEngine {
  const next = new GameEngine({ fast: true, now, save: JSON.parse(JSON.stringify(engine.serialize())) });
  bootToHome(next);
  return next;
}

function win(engine: GameEngine): void {
  playMission(engine, currentSpec(engine));
  if (engine.mode === 'mission' && traceOf(engine) >= 50) drain(engine, 'proxy');
  if (engine.mode === 'mission') drain(engine, 'disconnect');
}

describe('objectives (E02)', () => {
  it('dossier: only the designated file completes the job; the decoy dossier is optional loot', () => {
    const engine = engineAt(4);
    drain(engine, 'run 5');
    const spec = currentSpec(engine);
    expect(spec.objective.type).toBe('dossier');
    if (spec.objective.type !== 'dossier') return;
    drain(engine, 'scan');
    settle(engine);
    breachTo(engine, spec, spec.objective.nodeId);
    const files = walkSpecFilesWithPaths(nodeById(spec, spec.objective.nodeId)!.root);
    const decoy = files.find((f) => f.file.name.endsWith('.dossier') && f.file.tag === 'loot');
    if (decoy) {
      drain(engine, `download ${decoy.path}`);
      tickWhile(engine, () => engine.getState().mission?.transfer != null);
      expect(engine.getState().mission!.objective.done).toBe(false);
    }
    const real = files.find((f) => f.file.name === (spec.objective as { fileName: string }).fileName)!;
    const ev = drain(engine, `download ${real.path}`);
    expect(texts(ev)).toContain('TARGET');
    tickWhile(engine, () => engine.getState().mission?.transfer != null);
    expect(engine.getState().mission!.objective.done).toBe(true);
    drain(engine, 'disconnect');
    expect(engine.lastResult!.objectiveComplete).toBe(true);
    expect(engine.profile.contractsDone).toBe(5);
  });

  it('payload: upload validates box and directory, completes once, and never pays twice', () => {
    const engine = engineAt(6);
    drain(engine, 'run 7');
    const spec = currentSpec(engine);
    expect(spec.objective.type).toBe('payload');
    if (spec.objective.type !== 'payload') return;
    const o = spec.objective;
    drain(engine, 'scan');
    settle(engine);
    expect(texts(drain(engine, `upload ${o.payloadName}`))).toContain('wrong box');
    breachTo(engine, spec, o.nodeId);
    expect(texts(drain(engine, 'upload nonsense.bin'))).toContain(`only carries ${o.payloadName}`);
    expect(texts(drain(engine, `upload ${o.payloadName} /tmp`))).toContain(`drop point is ${o.dir}`);
    expect(engine.suggest).toBe(`upload ${o.payloadName} ${o.dir}`);
    drain(engine, `upload ${o.payloadName} ${o.dir}`);
    expect(engine.getState().mission!.transfer!.op).toBe('upload');
    tickWhile(engine, () => engine.getState().mission?.transfer != null);
    expect(engine.getState().mission!.objective.done).toBe(true);
    expect(texts(drain(engine, `upload ${o.payloadName} ${o.dir}`))).toContain('already planted');
    const ls = texts(drain(engine, `ls ${o.dir}`));
    expect(ls).toContain(o.payloadName);
    expect(texts(drain(engine, `rm ${o.dir}/${o.payloadName}`))).toContain('payload');
    drain(engine, 'disconnect');
    expect(engine.lastResult!.objectiveComplete).toBe(true);
  });

  it('the coach never picks a side at a fork', () => {
    const engine = engineAt(3);
    drain(engine, 'run 4');
    drain(engine, 'scan');
    settle(engine);
    expect(engine.suggest).toBe('');
    const out = texts(drain(engine, 'breach'));
    expect(out).toContain('from here you can reach');
  });

  it('past the junction the road not taken is not a choice — the coach points on', () => {
    // contract 7: deep nodes sit past the junction, so the junction holds no objective itself
    const engine = engineAt(6);
    drain(engine, 'run 7');
    const spec = currentSpec(engine);
    drain(engine, 'scan');
    settle(engine);
    const routeOf = (id: string) => nodeById(spec, id)!.route;
    const junction = spec.nodes.find(
      (n) => n.security > 0 && !n.route && !n.vault && spec.edges.some(([a, b]) => (a === n.id ? routeOf(b) : b === n.id ? routeOf(a) : null) === 'hot')
    )!;
    breachTo(engine, spec, junction.id, (id) => routeOf(id) === 'hot' || !!nodeById(spec, id)?.vault);
    expect(engine.getState().mission!.currentNodeId).toBe(junction.id);
    const hot = spec.nodes.filter((n) => n.route === 'hot').map((n) => n.ip);
    expect(engine.suggest).not.toBe('');
    for (const ip of hot) expect(engine.suggest).not.toContain(ip);
  });
});

describe('modifiers (E06)', () => {
  it('noisy link raises transfer trace by the configured factor and pays its bonus once', () => {
    const engine = engineAt(5);
    drain(engine, 'run 6');
    const spec = currentSpec(engine);
    expect(spec.modifier).toBe('noisy');
    const briefing = engine.getState().mission!.modifier!;
    expect(briefing.name).toBe('NOISY LINK');
    drain(engine, 'scan');
    settle(engine);
    const node = spec.nodes.find((n) => walkSpecFilesWithPaths(n.root).some((x) => x.file.tag === 'target'))!;
    breachTo(engine, spec, node.id);
    const f = walkSpecFilesWithPaths(node.root).find((x) => x.file.tag === 'target')!;
    drain(engine, `download ${f.path}`);
    expect(engine.getState().mission!.transfer!.traceRate).toBeCloseTo(CONFIG.trace.downloadPerSecond * CONFIG.modifiers.noisy.transferTraceMultiplier, 5);
    tickWhile(engine, () => engine.getState().mission?.transfer != null);
    playMission(engine, spec);
    if (traceOf(engine) >= 50) drain(engine, 'proxy');
    drain(engine, 'disconnect');
    expect(engine.lastResult!.modifierBonus).toBe(CONFIG.modifiers.noisy.bonus);
  });

  it('active patrol: a watchdog is out from the start and moves twice as fast', () => {
    const engine = engineAt(7);
    const ev = drain(engine, 'run 8');
    expect(texts(ev)).toContain('ACTIVE PATROL');
    const m = engine.getState().mission!;
    expect(m.watchdogNodeId).not.toBeNull();
    expect(m.trace).toBe(0);
    expect(m.cleanExitAvailable).toBe(true);
    const eff = effectiveFor({ module: null, upgrades: {} }, 'patrol');
    expect(eff.watchdogMoveSeconds).toBe(CONFIG.tools.watchdogMoveSeconds * CONFIG.modifiers.patrol.watchdogMoveMultiplier);
  });

  it('early extraction never pays the modifier bonus', () => {
    const s = scoreRun({ ended: 'disconnect', traceExact: 10, objectiveComplete: false, lootCash: 100, sessionXp: 40, logsWiped: 2, descriptor: campaignDescriptor(6), practice: false, modifier: 'noisy' });
    expect(s.outcome).toBe('early');
    expect(s.modifierBonus).toBe(0);
    expect(s.cash).toBe(100);
  });
});

describe('equipment (E03)', () => {
  it('modules unlock by rank and are announced at the rank-up', () => {
    expect(unlocksBetween(250, 320).map((m) => m.id)).toEqual(['burst']);
    expect(unlocksBetween(700, 900).map((m) => m.id)).toEqual(['quiet']);
    const rookie = engineAt(0, 0);
    expect(texts(drain(rookie, 'equip burst'))).toContain('unlocks at Operator');
    expect(rookie.profile.equipped).toBeNull();
  });

  it('equip/unequip at home; sealed mid-job with no side effects; persists through reload', () => {
    const engine = engineAt(2, 900);
    drain(engine, 'equip quiet');
    expect(engine.profile.equipped).toBe('quiet');
    const loadout = texts(drain(engine, 'loadout'));
    expect(loadout).toContain('quiet uplink');
    expect(loadout).toContain('effective');
    const r = reload(engine);
    expect(r.profile.equipped).toBe('quiet');
    drain(r, 'run 1');
    expect(r.getState().mission!.loadoutLabel).toContain('quiet');
    expect(texts(drain(r, 'equip burst'))).toContain('sealed mid-job');
    expect(r.profile.equipped).toBe('quiet');
    // a resumed run keeps the loadout it started with even if the slot changes
    const parked = reload(r);
    drain(parked, 'equip burst');
    drain(parked, 'resume');
    expect(parked.getState().mission!.loadoutLabel).toContain('quiet');
    drain(parked, 'disconnect');
    drain(parked, 'unequip');
    expect(parked.profile.equipped).toBeNull();
  });

  it('module numbers compose with overclock and show measurable tradeoffs', () => {
    const stock = effectiveFor({ module: null, upgrades: { overclock: 1 } }, null);
    const burst = effectiveFor({ module: 'burst', upgrades: { overclock: 1 } }, null);
    const quiet = effectiveFor({ module: 'quiet', upgrades: { overclock: 1 } }, null);
    expect(burst.downloadSeconds).toBeCloseTo(stock.downloadSeconds * 0.8, 6);
    expect(quiet.downloadSeconds).toBeCloseTo(stock.downloadSeconds * 1.25, 6);
    const perFile = (e: typeof stock) => e.downloadSeconds * CONFIG.trace.downloadPerSecond * e.transferTraceFactor;
    expect(perFile(burst) / perFile(stock)).toBeCloseTo(1.2, 2);
    expect(perFile(quiet) / perFile(stock)).toBeCloseTo(0.75, 2);
  });

  it('records identify the loadout', () => {
    const engine = engineAt(0, 400);
    drain(engine, 'equip burst');
    drain(engine, 'run 1');
    win(engine);
    expect(engine.records.recent[0]!.loadoutLabel).toContain('burst');
    expect(engine.records.recent[0]!.key).toContain('burst');
  });
});

describe('records (E04)', () => {
  const base: RecordEntry = {
    runId: 'a',
    key: 'k',
    code: 'c',
    label: 'l',
    mode: 'campaign',
    practice: false,
    outcome: 'clean',
    objectiveComplete: true,
    cash: 500,
    activeSeconds: 100,
    finalTrace: 30,
    loadoutLabel: 'stock',
    date: '2026-10-20T00:00:00Z',
  };

  it('orders completed > clean > payout > lower trace > faster; ties keep the earlier result', () => {
    const early: RecordEntry = { ...base, outcome: 'early', objectiveComplete: false, cash: 9999 };
    const hot: RecordEntry = { ...base, outcome: 'hot', cash: 9999 };
    expect(compareRecords(base, early)).toBeLessThan(0);
    expect(compareRecords(base, hot)).toBeLessThan(0);
    expect(compareRecords({ ...base, cash: 600 }, base)).toBeLessThan(0);
    expect(compareRecords({ ...base, finalTrace: 20 }, base)).toBeLessThan(0);
    expect(compareRecords({ ...base, activeSeconds: 90 }, base)).toBeLessThan(0);
    const first = recordRun(emptyRecords(), base).state;
    const tie = recordRun(first, { ...base, runId: 'b' });
    expect(tie.newBest).toBe(false);
    expect(tie.state.best.k!.runId).toBe('a');
  });

  it('a run is recorded once and lists stay bounded', () => {
    let st = emptyRecords();
    st = recordRun(st, base).state;
    const dup = recordRun(st, { ...base, cash: 99999 });
    expect(dup.duplicate).toBe(true);
    for (let i = 0; i < 200; i++) st = recordRun(st, { ...base, runId: `r${i}`, key: `k${i}`, date: new Date(i * 1000).toISOString() }).state;
    expect(st.recent.length).toBe(CONFIG.records.recentMax);
    expect(Object.keys(st.best).length).toBeLessThanOrEqual(CONFIG.records.bestMax);
  });

  it('`records` shows bests and recent runs; early/busted never outrank completed', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    win(engine);
    drain(engine, 'run 1');
    drain(engine, 'disconnect');
    const out = texts(drain(engine, 'records'));
    expect(out).toContain('campaign bests');
    expect(out).toContain('CLEAN EXIT');
    expect(out).toContain('EXTRACTED EARLY');
    const best = Object.values(engine.records.best).find((r) => r.code === encodeShareCode(campaignDescriptor(1)))!;
    expect(best.objectiveComplete).toBe(true);
  });
});

describe('daily challenge (E05)', () => {
  const at = (iso: string) => () => Date.parse(iso);

  it('same UTC date → same job for different profiles, rigs and timezones; tier and rig fixed', () => {
    const a = engineAt(0, 0, at('2026-10-20T23:30:00-05:00')); // 04:30 UTC on the 21st
    const b = engineAt(9, 5000, at('2026-10-21T09:00:00+09:00')); // 00:00 UTC on the 21st
    drain(b, 'equip quiet');
    b.profile.upgrades = { overclock: 3, relay: 2 };
    drain(a, 'daily start');
    drain(b, 'daily start');
    const ma = a.getState().mission!;
    const mb = b.getState().mission!;
    expect(ma.code).toBe(encodeShareCode(dailyDescriptor('2026-10-21')));
    expect(mb.code).toBe(ma.code);
    expect(mb.loadoutLabel).toBe(ma.loadoutLabel);
    expect(mb.loadoutLabel).toContain('stock');
    expect(currentSpec(a).descriptor.tier).toBe(CONFIG.daily.tier);
  });

  it('first run is recorded; reload/resume keeps it; later runs are practice and never overwrite it', () => {
    let now = Date.parse('2026-10-20T12:00:00Z');
    const clock = () => now;
    const engine = engineAt(3, 0, clock);
    drain(engine, 'daily start');
    expect(engine.getState().mission!.practice).toBe(false);
    expect(engine.daily['2026-10-20']!.status).toBe('live');
    // reload mid-run: eligibility is not reset; `daily start` resumes the recorded attempt
    const r = reload(engine, clock);
    drain(r, 'daily start');
    expect(r.mode).toBe('mission');
    expect(r.getState().mission!.practice).toBe(false);
    // finish after UTC midnight: the run keeps the date it started with
    now = Date.parse('2026-10-21T00:10:00Z');
    win(r);
    expect(r.daily['2026-10-20']!.status).toBe('finished');
    expect(r.lastResult!.code).toBe(encodeShareCode(dailyDescriptor('2026-10-20')));
    const recorded = { ...r.daily['2026-10-20']! };
    // retrying yesterday's daily is practice
    drain(r, '');
    expect(r.getState().mission!.practice).toBe(true);
    drain(r, 'disconnect');
    expect(r.daily['2026-10-20']).toEqual(recorded);
    // and the new day has its own fresh recorded attempt
    drain(r, 'daily start');
    expect(r.getState().mission!.code).toBe(encodeShareCode(dailyDescriptor('2026-10-21')));
    expect(r.getState().mission!.practice).toBe(false);
  });

  it('abandoning the recorded attempt keeps it on file as abandoned; the next run is practice', () => {
    const clock = at('2026-03-01T08:00:00Z');
    const engine = engineAt(0, 0, clock);
    drain(engine, 'daily start');
    const r = reload(engine, clock);
    expect(texts(drain(r, 'abandon'))).toContain('abandoned');
    expect(r.daily['2026-03-01']!.status).toBe('abandoned');
    drain(r, 'daily start');
    expect(r.getState().mission!.practice).toBe(true);
    expect(texts(drain(r, 'daily'))).toContain('mid-run');
  });

  it('a daily share code from another day plays as practice', () => {
    const engine = engineAt(0, 0, at('2026-10-20T12:00:00Z'));
    drain(engine, `run ${encodeShareCode(dailyDescriptor('2026-10-19'))}`);
    expect(engine.getState().mission!.practice).toBe(true);
  });
});

describe('modes and rewards', () => {
  it('custom jobs pay half the contract bonus and never clear a campaign contract', () => {
    const engine = engineAt(0);
    drain(engine, 'run seed easy money --tier 1');
    win(engine);
    expect(engine.lastResult!.objectiveComplete).toBe(true);
    expect(engine.lastResult!.missionBonus).toBe(Math.round(CONFIG.economy.missionBonus[1]! * CONFIG.modes.customBonusFactor));
    expect(engine.profile.contractsDone).toBe(0);
  });

  it('replaying a cleared contract pays but does not re-advance the board', () => {
    const engine = engineAt(3);
    drain(engine, 'run 2');
    win(engine);
    expect(engine.profile.contractsDone).toBe(3);
  });
});

describe('telemetry (E07)', () => {
  it('tutorial never counts; early, busted and completed are bucketed by contract and objective', () => {
    const engine = engineAt(0);
    engine.profile.tutorialDone = false;
    drain(engine, 'tutorial');
    for (const step of ['scan', 'breach 10.0.0.12', 'input 16', 'ls', 'cd srv', 'download ledger.dat', 'rm /var/log/auth.log', 'disconnect']) {
      drain(engine, step);
      settle(engine);
      tickWhile(engine, () => engine.getState().mission?.transfer != null);
    }
    expect(engine.profile.telemetry.runsStarted).toBe(0);
    drain(engine, 'run 1');
    drain(engine, 'disconnect');
    drain(engine, 'run 1');
    win(engine);
    const t = engine.profile.telemetry;
    expect(t.runsStarted).toBe(2);
    expect(t.runsShort).toBe(1);
    expect(t.runsCompleted).toBe(1);
    expect(t.byContract.c1).toEqual({ started: 2, completed: 1, early: 1, busted: 0 });
    expect(t.byObjective.flagged!.started).toBe(2);
    const stats = texts(drain(engine, 'stats'));
    expect(stats).toContain('by job');
    expect(stats).toContain('1 early');
  });

  it('wrong answers are counted by lock family', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const spec = currentSpec(engine);
    drain(engine, `breach ${spec.nodes[1]!.ip}`);
    settle(engine);
    const fam = engine.getState().mission!.puzzle!.family;
    drain(engine, fam === 'portknock' ? 'knock 1 2 3 4' : 'input 0');
    expect(engine.profile.telemetry.failuresByFamily[fam]).toBe(1);
  });
});

describe('simulation scenarios (F10/E07)', () => {
  it('the validator policy completes every mission in the bounded corpus; imperfect policies mostly do', () => {
    const report = runSimulation();
    expect(report.missions).toBe(simulationCorpus().length);
    const oracle = report.policies.find((p) => p.key === 'oracle')!;
    expect(oracle.completed).toBe(oracle.runs);
    expect(oracle.busted).toBe(0);
    const oneMistake = report.policies.find((p) => p.key === 'one-mistake')!;
    expect(oneMistake.completed / oneMistake.runs).toBeGreaterThanOrEqual(0.8);
    // modules trade off: burst is faster, quiet is quieter
    const by = (k: string) => report.loadouts.find((l) => l.key === k)!;
    expect(by('burst').avgTransferSeconds).toBeLessThan(by('stock').avgTransferSeconds);
    expect(by('quiet').avgTransferSeconds).toBeGreaterThan(by('stock').avgTransferSeconds);
    expect(by('quiet').avgEndTrace).toBeLessThan(by('burst').avgEndTrace);
    // neither fork road dominates: the long road is quieter, the hot road faster
    const long = report.routes.find((r) => r.key === 'long')!;
    const hot = report.routes.find((r) => r.key === 'hot')!;
    expect(long.avgPeakTrace).toBeLessThan(hot.avgPeakTrace);
    expect(hot.avgSeconds).toBeLessThan(long.avgSeconds);
  }, 60_000);

  it('simulations are deterministic', () => {
    const d: MissionDescriptor = customDescriptor('sim-determinism', 8);
    const spec = new GameEngine({ fast: true }).specFor(d);
    expect(playOracle(spec, { mistakes: 2, thinkScale: 3 })).toEqual(playOracle(spec, { mistakes: 2, thinkScale: 3 }));
  });
});
