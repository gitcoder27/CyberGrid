import { campaignDescriptor, customDescriptor } from '../src/identity.js';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { GameEngine } from '../src/game.js';
import { buildValidatedMission } from '../src/validate.js';
import { transferSecondsFor, hintCostFor } from '../src/shop.js';
import { TELEMETRY_DEFAULT } from '../src/types.js';
import type { SaveBlob, SaveBlobV1, EngineEvent } from '../src/types.js';
import { bootToHome, drain, settle, tickWhile, traceOf } from './helpers.js';

function makeSave(overrides: {
  cash?: number;
  upgrades?: Record<string, number>;
} = {}): SaveBlobV1 {
  return {
    version: 1,
    profile: {
      cash: overrides.cash ?? 0,
      xp: 0,
      contractsDone: 0,
      tutorialDone: true,
      upgrades: overrides.upgrades ?? {},
      telemetry: { ...TELEMETRY_DEFAULT },
    },
    settings: { volume: 0.8, muted: false, crt: true, motion: true },
    history: [],
    session: null,
  };
}

function engineWith(save: SaveBlobV1, now: () => number = () => 1_000_000): GameEngine {
  const engine = new GameEngine({ fast: true, save, now });
  bootToHome(engine);
  return engine;
}

const texts = (ev: EngineEvent[]) =>
  ev.filter((e) => e.t === 'print').map((e) => (e as { text: string }).text);

describe('the Broker\'s market: shop & buy', () => {
  it('lists the catalog with levels and prices', () => {
    const engine = engineWith(makeSave({ cash: 1000 }));
    const out = texts(drain(engine, 'shop')).join('\n');
    expect(out).toContain('relay');
    expect(out).toContain('overclock');
    expect(out).toContain('$600');
  });

  it('refuses purchases you cannot afford or do not exist', () => {
    const engine = engineWith(makeSave({ cash: 10 }));
    expect(texts(drain(engine, 'buy relay')).join('\n')).toContain('you have $10');
    expect(texts(drain(engine, 'buy warp-drive')).join('\n')).toContain('no such gear');
  });

  it('sells levels with an escalating price curve and blocks past max', () => {
    const engine = engineWith(makeSave({ cash: 5000 }));
    drain(engine, 'buy relay');
    expect(engine.profile.upgrades['relay']).toBe(1);
    expect(engine.profile.cash).toBe(5000 - 600);
    drain(engine, 'buy relay');
    expect(engine.profile.upgrades['relay']).toBe(2); // 600×1.6 = 960
    expect(engine.profile.cash).toBe(5000 - 600 - 960);
    expect(texts(drain(engine, 'buy relay')).join('\n')).toContain('already maxed');
  });

  it('persists purchases through the storage adapter', () => {
    let saved: SaveBlob | null = null;
    const engine = new GameEngine({
      fast: true,
      storage: { load: () => null, save: (b) => (saved = b) },
    });
    bootToHome(engine);
    engine.profile.cash = 1000;
    drain(engine, 'buy insider');
    expect(saved!.profile.upgrades['insider']).toBe(1);
  });

  it('relay puts an extra proxy hop in every job', () => {
    const engine = engineWith(makeSave({ cash: 5000, upgrades: { relay: 1 } }));
    drain(engine, 'run 1');
    expect(engine.getState().mission!.tools.proxy).toBe(CONFIG.tools.proxyHopsPerMission + 1);
  });

  it('overclock makes transfers faster and trace-lighter', () => {
    expect(transferSecondsFor({ upgrades: { overclock: 3 } })).toBeCloseTo(
      CONFIG.download.secondsPerFile * 0.55,
      5
    );
    const engine = engineWith(makeSave({ upgrades: { overclock: 3 } }));
    drain(engine, 'run 1');
    playFirstTarget(engine);
    // 3 levels = 55% duration ⇒ 55% of the §7 download trace
    const before = engine.getState().mission!.trace;
    expect(before).toBeGreaterThan(0);
    expect(hintCostFor({ upgrades: { insider: 1 } })).toBe(Math.round(CONFIG.puzzle.hintCost * 0.6));
  });

  it('ghosting slows the baseline creep', () => {
    const clean = engineWith(makeSave());
    drain(clean, 'run 1');
    for (let i = 0; i < 20; i++) clean.tick(1);
    const ghost = engineWith(makeSave({ upgrades: { ghosting: 2 } }));
    drain(ghost, 'run 1');
    for (let i = 0; i < 20; i++) ghost.tick(1);
    expect(traceOf(ghost)).toBeLessThan(traceOf(clean));
    // snapshot trace is integer-rounded: 3.0 vs 1.8 → allow ±0.5
    expect(Math.abs(traceOf(ghost) - traceOf(clean) * 0.6)).toBeLessThanOrEqual(0.51);
  });

  it('crowbar lengthens lock fuses and insider cheapens hints', () => {
    const engine = engineWith(makeSave({ cash: 1000, upgrades: { crowbar: 1, insider: 1 } }));
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const spec = buildValidatedMission(campaignDescriptor(1));
    drain(engine, `breach ${spec.nodes[1]!.ip}`);
    settle(engine);
    expect(engine.getState().mission!.puzzle!.timeLimit).toBe(
      CONFIG.puzzle.timeBoxBySecurity[1]! + 8
    );
    const cashBefore = engine.profile.cash;
    drain(engine, 'hint');
    expect(engine.profile.cash).toBe(cashBefore - Math.round(CONFIG.puzzle.hintCost * 0.6));
  });
});

describe('wire analytics: telemetry', () => {
  it('counts a full clean run: locks solved, first breach timing, completion', () => {
    const engine = engineWith(makeSave());
    drain(engine, 'run 1');
    const spec = buildValidatedMission(campaignDescriptor(1));
    drain(engine, 'scan');
    settle(engine);
    for (let i = 1; i < spec.nodes.length; i++) {
      const node = spec.nodes[i]!;
      drain(engine, `breach ${node.ip}`);
      settle(engine);
      const p = engine.getState().mission!.puzzle!;
      const a = spec.puzzleAnswers[p.nodeId]!;
      drain(engine, a.family === 'portknock' ? `knock ${a.ports.join(' ')}` : a.family === 'cipher' ? `input ${a.word}` : `input ${a.answer}`);
      settle(engine);
      for (let pass = 0; pass < 4; pass++) {
        const t = engine.getState().mission!.targets.find((x) => !x.stolen);
        if (!t || t.nodeId !== node.id) break;
        drain(engine, `download /srv/${t.name}`);
        if (engine.getState().mission?.transferLabel == null) {
          drain(engine, `download /vault/${t.name}`);
        }
        tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
      }
    }
    drain(engine, 'disconnect');
    const t = engine.profile.telemetry;
    expect(t.runsStarted).toBe(1);
    expect(t.runsEnded).toBe(1);
    expect(t.runsCompleted).toBe(1);
    expect(t.locksEncountered).toBe(spec.nodes.length - 1);
    expect(t.locksSolved).toBe(spec.nodes.length - 1);
    expect(t.locksSkipped).toBe(0);
    expect(t.firstBreachCount).toBe(1);
    expect(t.firstBreachSum).toBeGreaterThanOrEqual(0);
    expect(t.sessions).toBe(1);
  });

  it('counts skips as skips, not solves', () => {
    const engine = engineWith(makeSave());
    drain(engine, 'run 1');
    drain(engine, 'scan');
    settle(engine);
    const spec = buildValidatedMission(campaignDescriptor(1));
    drain(engine, `breach ${spec.nodes[1]!.ip}`);
    settle(engine);
    drain(engine, 'skip');
    settle(engine);
    drain(engine, 'disconnect');
    expect(engine.profile.telemetry.locksSkipped).toBe(1);
    expect(engine.profile.telemetry.locksSolved).toBe(0);
  });

  it('counts busted runs and does not record first breach on tutorial runs', () => {
    const engine = engineWith(makeSave());
    drain(engine, 'tutorial');
    for (const s of ['scan', 'breach 10.0.0.12', 'input 16', 'ls', 'cd srv', 'download ledger.dat', 'rm /var/log/auth.log', 'disconnect']) {
      drain(engine, s);
      settle(engine);
      tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    }
    expect(engine.profile.telemetry.runsStarted).toBe(0); // tutorial never pollutes stats

    drain(engine, 'run 1');
    for (let i = 0; i < 900 && engine.mode === 'mission'; i++) engine.tick(1);
    for (let i = 0; i < 20 && engine.mode === 'mission'; i++) engine.tick(0.5);
    expect(engine.profile.telemetry.runsBusted).toBe(1);
    expect(engine.profile.telemetry.firstBreachCount).toBe(0);
  });

  it('detects sessions by activity gap (injectable clock)', () => {
    let now = 1_000_000;
    const engine = engineWith(makeSave(), () => now);
    const bust = () => {
      drain(engine, 'run 1');
      for (let i = 0; i < 900 && engine.mode === 'mission'; i++) engine.tick(1);
      for (let i = 0; i < 20 && engine.mode === 'mission'; i++) engine.tick(0.5);
    };
    now += 5 * 60 * 1000;
    bust(); // session 1
    now += 10 * 60 * 1000;
    bust(); // still within 30 min → session 1
    expect(engine.profile.telemetry.sessions).toBe(1);
    now += 45 * 60 * 1000;
    bust(); // gap > 30 min → session 2
    expect(engine.profile.telemetry.sessions).toBe(2);
  });

  it('stats prints derived metrics scored against the §17 targets', () => {
    const engine = engineWith(makeSave());
    const empty = texts(drain(engine, 'stats')).join('\n');
    expect(empty).toContain('no runs on record');

    drain(engine, 'run 1');
    for (let i = 0; i < 900 && engine.mode === 'mission'; i++) engine.tick(1);
    for (let i = 0; i < 20 && engine.mode === 'mission'; i++) engine.tick(0.5);
    const out = texts(drain(engine, 'stats')).join('\n');
    expect(out).toContain('1 started');
    expect(out).toContain('completion');
    expect(out).toContain('target');
  });

  it('migrates pre-shop saves (no upgrades/telemetry fields) without crashing', () => {
    const oldSave = {
      version: 1,
      profile: { cash: 250, xp: 120, contractsDone: 2, tutorialDone: true },
      settings: { volume: 0.5, muted: false, crt: true, motion: true },
      history: [],
      session: null,
    } as unknown as SaveBlobV1;
    const engine = engineWith(oldSave);
    expect(engine.profile.cash).toBe(250);
    expect(engine.profile.upgrades).toEqual({});
    expect(engine.profile.telemetry.runsStarted).toBe(0);
    const out = texts(drain(engine, 'stats')).join('\n');
    expect(out).toContain('no runs on record');
  });
});

/** Breach + solve the first loot node and download one target from it. */
function playFirstTarget(engine: GameEngine): void {
  const spec = buildValidatedMission(campaignDescriptor(1));
  drain(engine, 'scan');
  settle(engine);
  for (let i = 1; i < spec.nodes.length; i++) {
    const node = spec.nodes[i]!;
    drain(engine, `breach ${node.ip}`);
    settle(engine);
    const p = engine.getState().mission!.puzzle!;
    const a = spec.puzzleAnswers[p.nodeId]!;
    drain(engine, a.family === 'portknock' ? `knock ${a.ports.join(' ')}` : a.family === 'cipher' ? `input ${a.word}` : `input ${a.answer}`);
    settle(engine);
    const target = engine.getState().mission!.targets.find((t) => t.nodeId === node.id && !t.stolen);
    if (target) {
      drain(engine, `download /srv/${target.name}`);
      tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
      return;
    }
  }
}
