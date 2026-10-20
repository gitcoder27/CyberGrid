import { campaignDescriptor, customDescriptor } from '../src/identity.js';
import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/game.js';
import { buildValidatedMission } from '../src/validate.js';
import type { SaveBlob, SaveBlobV1 } from '../src/types.js';
import { TELEMETRY_DEFAULT } from '../src/types.js';
import { bootToHome, settle, tickWhile, traceOf } from './helpers.js';

function makeSave(overrides: Partial<SaveBlobV1> = {}): SaveBlobV1 {
  return {
    version: 1,
    profile: { cash: 0, xp: 0, contractsDone: 0, tutorialDone: false, upgrades: {}, telemetry: { ...TELEMETRY_DEFAULT } },
    settings: { volume: 0.8, muted: false, crt: true, motion: true },
    history: [],
    session: null,
    ...overrides,
  };
}

describe('forgiving parsing (PRD §3.2)', () => {
  it('is case-insensitive and accepts aliases (dl/scp → download)', () => {
    const engine = fresh();
    for (const step of ['tutorial', 'SCAN', 'BREACH 10.0.0.12', 'input 999', 'ls', 'cd srv']) {
      engine.submit(step);
      settle(engine);
      tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    }
    engine.submit('dl ledger.dat');
    expect(engine.getState().mission!.transferLabel).toBe('ledger.dat');
    tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    // transfer completed → file exfiltrated (gone from the node), objective banked
    expect(engine.getState().mission!.transferLabel).toBeNull();
    expect(engine.getState().mission!.stolen).toBe(1);
  });

  it('suggests "did you mean" for near-miss verbs', () => {
    const engine = fresh();
    const ev = engine.submit('tutoria');
    const text = ev.find((e) => e.t === 'print' && e.text.includes('did you mean'));
    expect(text).toBeTruthy();
    // mission verbs suggest in mission mode only — `scann` at home has no neighbor
    const ev2 = engine.submit('scann');
    expect(ev2.some((e) => e.t === 'print' && e.text.includes('did you mean'))).toBe(false);
  });

  it('tolerates `scp x local` phrasing', () => {
    const engine = fresh();
    for (const step of ['tutorial', 'scan', 'breach 10.0.0.12', 'input 999', 'ls', 'cd srv']) {
      engine.submit(step);
      settle(engine);
      tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    }
    engine.submit('scp ledger.dat local');
    expect(engine.getState().mission!.transferLabel).toBe('ledger.dat');
  });
});

describe('TAB autocomplete', () => {
  it('completes command names per mode', () => {
    const engine = fresh();
    expect(engine.complete('tuto')).toEqual({ items: ['tutorial'], from: 0 });
    expect(engine.complete('con')).toEqual({ items: ['contracts'], from: 0 });
    engine.submit('tutorial');
    settle(engine);
    // mission mode offers mission verbs (`contracts` is home-only)
    expect(engine.complete('con')).toEqual({ items: ['connect'], from: 0 });
    expect(engine.complete('sca')).toEqual({ items: ['scan'], from: 0 });
  });

  it('completes file paths in mission mode', () => {
    const engine = fresh();
    for (const step of ['tutorial', 'scan', 'breach 10.0.0.12', 'input 16']) {
      engine.submit(step);
      settle(engine);
    }
    expect(engine.complete('cat s').items).toContain('srv/');
    expect(engine.complete('cd sr').items).toContain('srv/');
    expect(engine.complete('ls /var/l').items).toContain('/var/log/');
  });

  it('completes reachable node ips for breach', () => {
    const engine = fresh();
    for (const step of ['tutorial', 'scan']) {
      engine.submit(step);
      settle(engine);
    }
    expect(engine.complete('breach ').items).toContain('10.0.0.12');
  });
});

describe('history', () => {
  it('records submitted commands, dedupes consecutive repeats', () => {
    const engine = fresh();
    engine.submit('help');
    engine.submit('help');
    engine.submit('about');
    expect(engine.history).toEqual(['help', 'about']);
  });
});

describe('persistence & resume (PRD §4.3, §10)', () => {
  it('autosaves profile after a mission via the storage adapter', () => {
    const store: { blob: SaveBlob | null } = { blob: null };
    const engine = new GameEngine({
      fast: true,
      storage: {
        load: () => store.blob,
        save: (b) => (store.blob = b),
      },
    });
    bootToHome(engine);
    engine.submit('run 1');
    // quick busted via idle → still triggers persist at mission end
    for (let i = 0; i < 900 && engine.mode === 'mission'; i++) engine.tick(1);
    for (let i = 0; i < 20 && engine.mode === 'mission'; i++) engine.tick(0.5);
    expect(engine.mode).toBe('post');
    expect(store.blob).not.toBeNull();
    expect(store.blob!.session).toBeNull();
  });

  it('a mid-mission session survives serialize → new engine → resume', () => {
    const engine = freshWithContract();
    engine.submit('scan');
    settle(engine);
    // breach + loot the first node
    engine.submit('breach ' + engine.getState().mission!.nodes[1]!.ip);
    settle(engine);
    answerLock(engine);
    settle(engine);
    const target = engine.getState().mission!.targets.find((t) => !t.stolen)!;
    engine.submit(`download ${target.name}`);
    tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    const traceBefore = traceOf(engine);
    const targetsBefore = engine.getState().mission!.stolen;

    const blob = engine.serialize();
    expect(blob.session).not.toBeNull();

    const engine2 = new GameEngine({ fast: true, save: blob });
    bootToHome(engine2);
    expect(engine2.mode).toBe('home');
    const ev = engine2.submit('resume');
    expect(engine2.mode).toBe('mission');
    expect(traceOf(engine2)).toBeCloseTo(traceBefore, 1);
    expect(engine2.getState().mission!.stolen).toBe(targetsBefore);
    expect(ev.some((e) => e.t === 'print')).toBe(true);

    // and the resumed run can finish
    finishRun(engine2);
    expect(engine2.mode).toBe('post');
  });

  it('settings changes persist through the storage adapter', () => {
    const store: { blob: SaveBlob | null } = { blob: null };
    const engine = new GameEngine({
      fast: true,
      storage: {
        load: () => store.blob,
        save: (b) => (store.blob = b),
      },
    });
    bootToHome(engine);
    engine.submit('settings volume 0.3');
    engine.submit('settings crt off');
    expect(store.blob!.settings.volume).toBe(0.3);
    expect(store.blob!.settings.crt).toBe(false);
    const engine2 = new GameEngine({
      fast: true,
      storage: { load: () => store.blob, save: (b) => (store.blob = b) },
    });
    bootToHome(engine2);
    expect(engine2.getState().settings.volume).toBe(0.3);
    expect(engine2.getState().settings.crt).toBe(false);
  });

  it('abandon clears a recoverable session', () => {
    const engine = freshWithContract();
    engine.submit('scan');
    settle(engine);
    const blob = engine.serialize();
    const engine2 = new GameEngine({ fast: true, save: blob });
    engine2.submit('abandon');
    expect(engine2.serialize().session).toBeNull();
  });
});

describe('rank progression (PRD §10)', () => {
  it('rank titles follow xp thresholds', () => {
    const engine = fresh();
    expect(engine.getState().profile.rank).toBe('Script Kiddie');
    engine.profile.xp = 900;
    expect(engine.getState().profile.rank).toBe('Breacher');
    engine.profile.xp = 4000;
    expect(engine.getState().profile.rank).toBe('Elite Operator');
  });
});

describe('post-mission screen', () => {
  it('accepts `run <n>` directly, so a suggested command is never a dead end', () => {
    const engine = fresh();
    engine.submit('run 1');
    // bust out fast: idle until the grid catches you, cutscene plays out
    for (let i = 0; i < 900 && engine.mode === 'mission'; i++) engine.tick(1);
    for (let i = 0; i < 20 && engine.mode === 'mission'; i++) engine.tick(0.5);
    expect(engine.mode).toBe('post');
    engine.submit('run 1');
    expect(engine.mode).toBe('mission');
    expect(engine.getState().mission!.isTutorial).toBe(false);
  });
});

function fresh(): GameEngine {
  const engine = new GameEngine({ fast: true });
  bootToHome(engine);
  return engine;
}

function freshWithContract(): GameEngine {
  const engine = new GameEngine({ fast: true });
  bootToHome(engine);
  engine.submit('run 1');
  return engine;
}

function answerLock(engine: GameEngine): void {
  const puzzle = engine.getState().mission!.puzzle;
  if (!puzzle) return;
  const spec = buildValidatedMission(campaignDescriptor(1));
  const a = spec.puzzleAnswers[puzzle.nodeId]!;
  if (a.family === 'portknock') engine.submit(`knock ${a.ports.join(' ')}`);
  else if (a.family === 'cipher') engine.submit(`input ${a.word}`);
  else engine.submit(`input ${a.answer}`);
}

function finishRun(engine: GameEngine): void {
  const spec = buildValidatedMission(campaignDescriptor(1));
  for (let i = 1; i < spec.nodes.length; i++) {
    if (engine.mode !== 'mission') return;
    const node = spec.nodes[i]!;
    const snap = engine.getState().mission!;
    if (snap.nodes[i]?.status === 'locked') {
      engine.submit(`breach ${node.ip}`);
      settle(engine);
      answerLock(engine);
      settle(engine);
    } else {
      engine.submit(`connect ${node.ip}`);
      settle(engine);
    }
    for (let pass = 0; pass < 4; pass++) {
      const t = engine.getState().mission!.targets.find((x) => x.nodeId === node.id && !x.stolen);
      if (!t) break;
      engine.submit(`download ${t.name}`);
      tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    }
    if ((engine.getState().mission?.trace ?? 0) >= 80) engine.submit('proxy');
  }
  engine.submit('disconnect');
}
