import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { GameEngine } from '../src/game.js';
import { campaignDescriptor } from '../src/identity.js';
import { nodeById } from '../src/graph.js';
import { TUTORIAL_STEPS } from '../src/tutorial.js';
import { walkSpecFilesWithPaths } from '../src/vfs.js';
import type { EngineEvent, MissionSpec, SaveBlob } from '../src/types.js';
import { bootToHome, breachTo, drain, playMission, settle, solveLock, tickWhile, traceOf } from './helpers.js';

const texts = (ev: EngineEvent[]) => ev.filter((e) => e.t === 'print').map((e) => (e as { text: string }).text).join('\n');

function engineAt(contractsDone: number, extra: Partial<SaveBlob['profile']> = {}): GameEngine {
  const engine = new GameEngine({
    fast: true,
    save: {
      version: 2,
      profile: { cash: 2000, xp: 0, contractsDone, tutorialDone: true, upgrades: {}, ...extra },
      settings: {},
      history: [],
      session: null,
    },
  });
  bootToHome(engine);
  return engine;
}

/** serialize → JSON → fresh engine → resume: what a page reload does. */
function reload(engine: GameEngine, resume = true): GameEngine {
  const blob = JSON.parse(JSON.stringify(engine.serialize()));
  const next = new GameEngine({ fast: true, save: blob });
  bootToHome(next);
  if (resume) next.submit('resume');
  return next;
}

function spec(engine: GameEngine): MissionSpec {
  return engine.specFor(engine.getState().mission ? (engine as unknown as { rt: { spec: MissionSpec } }).rt.spec.descriptor : campaignDescriptor(1));
}

function finish(engine: GameEngine): void {
  playMission(engine, spec(engine));
  if (engine.mode === 'mission' && traceOf(engine) >= CONFIG.trace.cleanExitUnder) drain(engine, 'proxy');
  if (engine.mode === 'mission') drain(engine, 'disconnect');
}

describe('F01 — results-screen input', () => {
  it('empty Enter retries; typed commands run normally from results', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    finish(engine);
    expect(engine.mode).toBe('post');
    expect(engine.profile.contractsDone).toBe(1);

    const board = drain(engine, 'contracts');
    expect(engine.mode).toBe('home');
    expect(texts(board)).toContain('THE BOARD');

    // back to results via another run
    drain(engine, 'run 1');
    drain(engine, 'disconnect');
    expect(engine.mode).toBe('post');
    expect(texts(drain(engine, 'profile'))).toContain('OPERATOR FILE');
    expect(engine.mode).toBe('post');
    drain(engine, 'settings mute on');
    expect(engine.settings.muted).toBe(true);
    drain(engine, 'run 2');
    expect(engine.mode).toBe('mission');
    expect(engine.getState().mission!.index).toBe(2);
    drain(engine, 'disconnect');

    // empty Enter = retry of the same configuration
    const code = engine.lastResult!.code;
    drain(engine, '');
    expect(engine.mode).toBe('mission');
    expect(engine.getState().mission!.code).toBe(code);
  });

  it('the suggestion after a clean contract is the next contract, and it runs', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    finish(engine);
    expect(engine.suggest).toBe('run 2');
    drain(engine, engine.suggest);
    expect(engine.getState().mission!.index).toBe(2);
  });
});

describe('F02 — a parked run is never silently lost', () => {
  it('survives serialize → reload → settings change → reload, until resumed', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const runId = engine.serialize().session!.runId;

    const a = reload(engine, false);
    expect(a.serialize().session?.runId).toBe(runId);
    drain(a, 'settings crt off');
    a.persist();
    const b = reload(a, false);
    expect(b.serialize().session?.runId).toBe(runId);
    expect(b.getState().pending).not.toBeNull();
    drain(b, 'resume');
    expect(b.mode).toBe('mission');
    expect(b.serialize().session?.runId).toBe(runId);
  });

  it('starting another job while one is parked is refused with guidance', () => {
    const engine = engineAt(1);
    drain(engine, 'run 1');
    const home = reload(engine, false);
    for (const cmd of ['run 2', 'tutorial', 'run seed foo', 'daily start']) {
      const out = texts(drain(home, cmd));
      expect(home.mode, cmd).toBe('home');
      expect(out).toContain('`resume` it, or `abandon` it first');
    }
    expect(home.serialize().session).not.toBeNull();
    drain(home, 'abandon');
    expect(home.serialize().session).toBeNull();
    drain(home, 'run 2');
    expect(home.mode).toBe('mission');
  });
});

describe('F03 — resume restores the whole running game', () => {
  it('tutorial checkpoints: every step resumes with the right guidance and accepts the next command', () => {
    for (let k = 0; k < TUTORIAL_STEPS.length; k++) {
      let engine = new GameEngine({ fast: true });
      bootToHome(engine);
      drain(engine, 'tutorial');
      for (let i = 0; i < k; i++) {
        drain(engine, TUTORIAL_STEPS[i]!.cmd.join(' '));
        settle(engine);
        tickWhile(engine, () => engine.getState().mission?.transfer != null);
      }
      engine = reload(engine);
      expect(engine.mode, `step ${k}`).toBe('mission');
      expect(engine.suggest, `step ${k}`).toBe(TUTORIAL_STEPS[k]!.cmd.join(' '));
      const out = texts(drain(engine, TUTORIAL_STEPS[k]!.cmd.join(' ')));
      expect(out, `step ${k}`).not.toContain('the glow knows best');
    }
  });

  it('an upgraded fuse near expiry resumes with the same limit, elapsed time and fuse warnings', () => {
    const engine = engineAt(0, { upgrades: { crowbar: 2 } });
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const s = spec(engine);
    drain(engine, `breach ${s.nodes[1]!.ip}`);
    settle(engine);
    const before = engine.getState().mission!.puzzle!;
    expect(before.timeLimit).toBe(CONFIG.puzzle.timeBoxBySecurity[s.nodes[1]!.security]! + 16);
    for (let i = 0; i < 40; i++) engine.tick(1);
    const left = engine.getState().mission!.puzzle!.timeLeft;
    expect(left).toBeLessThan(before.timeLimit / 4);
    const r = reload(engine);
    const after = r.getState().mission!.puzzle!;
    expect(after.timeLimit).toBe(before.timeLimit);
    expect(after.timeLeft).toBeCloseTo(left, 5);
    // the quarter warning already fired; it must not fire again
    let ev: EngineEvent[] = [];
    for (let i = 0; i < 3; i++) ev = ev.concat(r.tick(0.5));
    expect(texts(ev)).not.toContain('FUSE BURNING');
  });

  it('knock input, cipher hint, cwd and trace breakdown survive a reload', () => {
    // find a campaign contract with a knock lock
    for (const idx of [2, 3, 4, 5, 6]) {
      const engine = engineAt(idx - 1);
      drain(engine, `run ${idx}`);
      drain(engine, 'scan');
      settle(engine);
      const s = spec(engine);
      const knock = s.nodes.find((n) => n.puzzleFamily === 'portknock' && n.security > 0);
      if (!knock) continue;
      const via = s.edges.find(([a, b]) => b === knock.id || a === knock.id)!;
      breachTo(engine, s, via[0] === knock.id ? via[1] : via[0]);
      drain(engine, 'cd /var');
      drain(engine, `breach ${knock.ip}`);
      settle(engine);
      const ans = s.puzzleAnswers[knock.id]!;
      if (ans.family !== 'portknock') continue;
      drain(engine, String(ans.ports[0]));
      const breakdown = engine.serialize().session!.breakdown.entries;
      const r = reload(engine);
      const m = r.getState().mission!;
      expect(m.puzzle!.knockEntered).toBe(1);
      expect(r.serialize().session!.cwd).toEqual(['var']);
      expect(r.serialize().session!.breakdown.entries).toEqual(breakdown);
      drain(r, `knock ${ans.ports.slice(1).join(' ')}`);
      expect(r.getState().mission!.currentNodeId).toBe(knock.id);
      return;
    }
    throw new Error('no knock lock in contracts 2–6');
  });

  it('a partial transfer resumes at the same percentage and pays exactly once', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const s = spec(engine);
    const node = s.nodes.find((n) => walkSpecFilesWithPaths(n.root).some((x) => x.file.tag === 'target'))!;
    breachTo(engine, s, node.id);
    const file = walkSpecFilesWithPaths(node.root).find((x) => x.file.tag === 'target')!;
    drain(engine, `download ${file.path}`);
    for (let i = 0; i < 8; i++) engine.tick(0.1);
    const pct = engine.getState().mission!.transfer!.pct;
    expect(pct).toBeGreaterThan(20);
    const r = reload(engine);
    expect(r.getState().mission!.transfer!.pct).toBe(pct);
    tickWhile(r, () => r.getState().mission?.transfer != null);
    expect(r.getState().mission!.stolen).toBe(1);
    expect(r.getState().mission!.sessionCash).toBe(file.file.value);
    // the file is gone from the node, so a second download is impossible
    const again = texts(drain(r, `download ${file.path}`));
    expect(again).toContain('no such file');
  });

  it('a pending scan/breach is stored as data and completes after resume', () => {
    const engine = new GameEngine({ save: { version: 2, profile: { tutorialDone: true }, settings: {}, history: [], session: null } });
    bootToHome(engine);
    drain(engine, 'run 1');
    drain(engine, 'scan');
    expect(engine.serialize().session!.pending).toEqual({ remaining: CONFIG.delays.scan, action: { type: 'scan' } });
    const r = new GameEngine({ save: JSON.parse(JSON.stringify(engine.serialize())) });
    bootToHome(r);
    r.submit('resume');
    for (let i = 0; i < 10; i++) r.tick(0.1);
    expect(r.getState().mission!.nodes[0]!.scanned).toBe(true);
  });

  it('resume counts as continuation: no new run, no duplicate first-breach sample, no double payout', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const s = spec(engine);
    drain(engine, `breach ${s.nodes[1]!.ip}`);
    settle(engine);
    solveLock(engine, s);
    const r = reload(engine);
    expect(r.profile.telemetry.runsStarted).toBe(1);
    expect(r.profile.telemetry.resumes).toBe(1);
    const cashBefore = r.profile.cash;
    finish(r);
    expect(r.profile.telemetry.runsEnded).toBe(1);
    expect(r.profile.telemetry.firstBreachCount).toBe(1);
    expect(r.profile.cash - cashBefore).toBe(r.lastResult!.cash);
    // closing the tab after the result cannot pay again
    const again = reload(r, false);
    expect(again.serialize().session).toBeNull();
    expect(again.records.recent.filter((x) => x.runId === r.lastResult!.runId)).toHaveLength(1);
  });

  it('time with the app closed is not mission time', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    for (let i = 0; i < 10; i++) engine.tick(1);
    const t = engine.getState().mission!.elapsed;
    const r = reload(engine);
    expect(r.getState().mission!.elapsed).toBeCloseTo(t, 5);
    expect(traceOf(r)).toBe(traceOf(engine));
  });
});

describe('F04 — cipher clues are reachable before the lock is solved', () => {
  it('the wheel tag can be read during the lock and lights the decoding strip', () => {
    for (let idx = 1; idx <= 10; idx++) {
      const engine = engineAt(idx - 1);
      drain(engine, `run ${idx}`);
      drain(engine, 'scan');
      settle(engine);
      const s = spec(engine);
      const lock = s.nodes.find((n) => n.puzzleFamily === 'cipher' && n.security > 0);
      if (!lock) continue;
      const holder = s.nodes.find((n) => walkSpecFilesWithPaths(n.root).some((x) => x.file.clueFor === lock.id))!;
      breachTo(engine, s, holder.id);
      if (!s.edges.some(([a, b]) => (a === holder.id && b === lock.id) || (b === holder.id && a === lock.id))) continue;
      const scanText = texts(drain(engine, 'scan').concat(engine.tick(0)));
      expect(scanText).toContain('cipher tag');
      const open = texts(drain(engine, `breach ${lock.ip}`).concat(engine.tick(0)));
      expect(open).toContain('wheel tag');
      expect(engine.getState().mission!.puzzle!.cipherWheel).toBeNull();
      const clue = walkSpecFilesWithPaths(holder.root).find((x) => x.file.clueFor === lock.id)!;
      const read = texts(drain(engine, `cat ${clue.path}`));
      expect(read).toContain('offset');
      const ans = s.puzzleAnswers[lock.id]!;
      if (ans.family !== 'cipher') throw new Error('cipher expected');
      expect(read.toUpperCase()).not.toContain(ans.word);
      const p = engine.getState().mission!.puzzle!;
      expect(p.cipherWheel).not.toBeNull();
      expect(engine.mode).toBe('mission');
      drain(engine, `input ${ans.word}`);
      expect(engine.getState().mission!.currentNodeId).toBe(lock.id);
      return;
    }
    throw new Error('no cipher lock in the campaign');
  });
});

describe('F05 — completion and exit quality are separate', () => {
  it('an empty run earns nothing and is EXTRACTED EARLY', () => {
    const engine = engineAt(0);
    for (let i = 0; i < 6; i++) {
      drain(engine, 'run 1');
      const out = texts(drain(engine, 'disconnect'));
      expect(out).toContain('EXTRACTED EARLY');
      expect(engine.lastResult!.outcome).toBe('early');
    }
    expect(engine.profile.xp).toBe(0);
    expect(engine.profile.cash).toBe(2000);
    expect(engine.profile.contractsDone).toBe(0);
  });

  it('partial extraction keeps carried loot but no bonuses and never clears the contract', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const s = spec(engine);
    const node = s.nodes.find((n) => walkSpecFilesWithPaths(n.root).some((x) => x.file.tag === 'target'))!;
    breachTo(engine, s, node.id);
    const f = walkSpecFilesWithPaths(node.root).find((x) => x.file.tag === 'target')!;
    drain(engine, `download ${f.path}`);
    tickWhile(engine, () => engine.getState().mission?.transfer != null);
    drain(engine, 'disconnect');
    const r = engine.lastResult!;
    expect(r.outcome).toBe('early');
    expect(r.objectiveComplete).toBe(false);
    expect(r.cash).toBe(f.file.value);
    expect(r.cleanBonus + r.missionBonus + r.modifierBonus).toBe(0);
    expect(engine.profile.contractsDone).toBe(0);
  });

  it('clean/hot threshold uses the authoritative trace (49.9 is clean, 50.0 is hot)', () => {
    for (const [trace, want] of [
      [49.95, 'clean'],
      [50, 'hot'],
    ] as const) {
      const engine = engineAt(0);
      drain(engine, 'run 1');
      playMission(engine, spec(engine));
      const rt = (engine as unknown as { rt: { trace: number } }).rt;
      rt.trace = trace;
      drain(engine, 'disconnect');
      expect(engine.lastResult!.outcome, String(trace)).toBe(want);
      expect(engine.lastResult!.trace).toBe(Math.floor(trace));
    }
  });
});

describe('F07 — campaign completion', () => {
  it('clearing contract 10 shows the ending once and never suggests run 11', () => {
    const engine = engineAt(9);
    drain(engine, 'run 10');
    finish(engine);
    expect(engine.lastResult!.objectiveComplete).toBe(true);
    expect(engine.lastResult!.campaignCleared).toBe(true);
    expect(engine.profile.campaignComplete).toBe(true);
    expect(engine.profile.contractsDone).toBe(10);
    expect(engine.profile.endingSeen).toBe(true);
    expect(engine.suggest).not.toMatch(/run 11/);
    const board = texts(drain(engine, 'contracts'));
    expect(board).toContain('CAMPAIGN COMPLETE');
    expect(engine.suggest).toBe('daily');
    const r = reload(engine, false);
    const boot = texts(r.tick(0));
    expect(boot).not.toContain('SECURE CHANNEL');
    expect(texts(drain(r, 'epilogue'))).toContain('SECURE CHANNEL');
    // replaying 10 does not re-trigger the ending
    drain(r, 'run 10');
    finish(r);
    expect(r.lastResult!.campaignCleared).toBe(false);
    expect(r.profile.contractsDone).toBe(10);
  });
});

describe('F08 — panic tools during a lock', () => {
  it('proxy and decoy work mid-lock without touching the puzzle', () => {
    const engine = engineAt(0);
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const s = spec(engine);
    drain(engine, `breach ${s.nodes[1]!.ip}`);
    settle(engine);
    engine.tick(2);
    const p0 = engine.getState().mission!.puzzle!;
    const trace0 = engine.getState().mission!.traceExact;
    drain(engine, 'proxy');
    const m = engine.getState().mission!;
    expect(m.tools.proxy).toBe(0);
    expect(m.traceExact).toBeLessThan(trace0);
    expect(m.puzzle!.timeLeft).toBe(p0.timeLeft);
    expect(m.puzzle!.attempts).toBe(p0.attempts);
    // decoy with no watchdog: rejected, consumes nothing
    expect(texts(drain(engine, 'decoy'))).toContain('nothing is hunting you');
    expect(engine.getState().mission!.tools.decoy).toBe(1);
    // with a watchdog, it works mid-lock
    const rt = (engine as unknown as { rt: { watchdogNodeId: string } }).rt;
    rt.watchdogNodeId = s.nodes[1]!.id;
    drain(engine, 'decoy-node');
    expect(engine.getState().mission!.tools.decoy).toBe(0);
    expect(engine.getState().mission!.decoyActive).toBe(true);
    expect(engine.getState().mission!.puzzle).not.toBeNull();
    solveLock(engine, s);
    expect(engine.getState().mission!.currentNodeId).toBe(s.nodes[1]!.id);
  });
});

describe('graph rules', () => {
  it('breach requires a link; the error names the node to connect through', () => {
    const engine = engineAt(3);
    drain(engine, 'run 4');
    drain(engine, 'scan');
    settle(engine);
    const s = spec(engine);
    const junction = s.nodes.find((n) => n.pos?.row === 3)!;
    const out = texts(drain(engine, `breach ${junction.ip}`));
    expect(out).toContain('no route yet');
    const long1 = s.nodes.find((n) => n.route === 'long')!;
    breachTo(engine, s, long1.id);
    drain(engine, 'connect ' + nodeById(s, 'n0')!.ip);
    const deeper = s.nodes.find((n) => n.route === 'long' && n.id !== long1.id)!;
    expect(texts(drain(engine, `breach ${deeper.ip}`))).toContain(`connect ${long1.ip}`);
  });
});
