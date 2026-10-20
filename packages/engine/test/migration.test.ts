import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/game.js';
import { migrateSave } from '../src/persistence.js';
import type { EngineEvent, SaveBlob } from '../src/types.js';
import { bootToHome, drain, settle, tickWhile } from './helpers.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/legacy-v1-saves.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const texts = (ev: EngineEvent[]) => ev.filter((e) => e.t === 'print').map((e) => (e as { text: string }).text).join('\n');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function load(raw: unknown): { engine: GameEngine; boot: string } {
  const engine = new GameEngine({ fast: true, save: clone(raw) });
  const boot = texts(engine.submit('skip'));
  return { engine, boot };
}

describe('save migration v1 → v2', () => {
  it('keeps cash, XP, cleared contracts, purchases and settings', () => {
    const { blob, from } = migrateSave(clone(fixtures.contractTransfer));
    expect(from).toBe(1);
    expect(blob.version).toBe(2);
    expect(blob.profile).toMatchObject({ cash: 1234, xp: 950, contractsDone: 3, tutorialDone: true, upgrades: { overclock: 1 } });
    expect(blob.profile.equipped).toBeNull();
    expect(blob.profile.campaignComplete).toBe(false);
    expect(blob.settings).toMatchObject({ volume: 0.4, muted: true, crt: false, motion: false, typing: true, assist: true });
    expect(blob.profile.telemetry.runsStarted).toBe(8);
    expect(blob.history.length).toBeGreaterThan(0);
  });

  it('a profile-only v1 save (pre-shop, pre-telemetry) migrates cleanly', () => {
    const { engine } = load(fixtures.preShop);
    expect(engine.profile).toMatchObject({ cash: 250, xp: 120, contractsDone: 2, upgrades: {} });
    expect(engine.serialize().session).toBeNull();
    drain(engine, 'run 3');
    expect(engine.mode).toBe('mission');
  });

  it('a legacy mid-transfer contract resumes on the same generation-1 network with the transfer intact', () => {
    const { engine, boot } = load(fixtures.contractTransfer);
    expect(boot).toContain('parked run');
    const out = texts(drain(engine, 'resume'));
    expect(engine.mode).toBe('mission');
    expect(out).toContain('resumes at 44%');
    const m = engine.getState().mission!;
    expect(m.code).toMatch(/^CG1-1C01/);
    expect(m.currentNodeId).toBe('n2');
    expect(m.traceExact).toBeCloseTo(19.2625, 3);
    expect(m.transfer!.file).toBe('schema_backup.sql');
    expect(m.transfer!.pct).toBe(44);
    // legacy runs keep the rig they started with: the overclock purchase
    expect(m.loadoutLabel).toContain('overclock');
    tickWhile(engine, () => engine.getState().mission?.transfer != null);
    expect(engine.getState().mission!.sessionCash).toBeGreaterThan(0);
    // the breakdown says honestly that part of it predates detailed logging
    drain(engine, 'disconnect');
    expect(engine.lastResult!.breakdownComplete).toBe(false);
    expect(engine.lastResult!.breakdown.some((b) => b.label === 'unrecorded')).toBe(true);
    // a legacy campaign run does not count as a fresh start
    expect(engine.profile.telemetry.runsStarted).toBe(8);
  });

  it('a legacy tutorial resumes at the download step with matching guidance', () => {
    const { engine } = load(fixtures.tutorialDownloadStep);
    drain(engine, 'resume');
    expect(engine.mode).toBe('mission');
    expect(engine.suggest).toBe('download ledger.dat');
    const out = texts(drain(engine, 'download ledger.dat'));
    expect(out).not.toContain('the glow knows best');
    tickWhile(engine, () => engine.getState().mission?.transfer != null);
    expect(engine.getState().mission!.stolen).toBe(1);
  });

  it('a legacy cipher lock resumes with the crowbar fuse (51s) and 12.35s left — plus a readable clue', () => {
    const fx = fixtures.cipherLock as { blob: unknown; timeLimit: number; timeLeft: number };
    const { engine } = load(fx.blob);
    drain(engine, 'resume');
    const p = engine.getState().mission!.puzzle!;
    expect(p.family).toBe('cipher');
    expect(p.timeLimit).toBe(fx.timeLimit);
    expect(p.timeLeft).toBeCloseTo(fx.timeLeft, 5);
    // the clue now lives on the node you stand on and can be read mid-lock
    expect(p.clueHint).toContain('this node');
    const read = texts(drain(engine, 'cat /srv/' + p.clueHint!.split(' ')[0]!.split('/').pop()));
    expect(read).toContain('offset');
    expect(read).not.toContain('UPLINK');
    expect(engine.getState().mission!.puzzle!.cipherWheel).not.toBeNull();
    drain(engine, 'input UPLINK');
    expect(engine.getState().mission!.currentNodeId).toBe('n4');
  });

  it('migration is persisted once and reloads as v2 without losing the parked run', () => {
    const saved: SaveBlob[] = [];
    const engine = new GameEngine({ fast: true, storage: { load: () => clone(fixtures.contractTransfer), save: (b) => saved.push(clone(b)) } });
    bootToHome(engine);
    engine.persist();
    const v2 = saved.at(-1)!;
    expect(v2.version).toBe(2);
    expect(v2.session?.descriptor.gen).toBe(1);
    const again = new GameEngine({ fast: true, save: v2 });
    bootToHome(again);
    drain(again, 'resume');
    expect(again.getState().mission!.transfer!.pct).toBe(44);
  });

  it('a session that cannot be rebuilt becomes a broken session: profile kept, abandon clears it', () => {
    const raw = clone(fixtures.contractTransfer) as { session: { currentNodeId: string; index: number } };
    raw.session.currentNodeId = 'n99';
    const { engine, boot } = load(raw);
    expect(boot).toContain("can't be rebuilt");
    expect(engine.profile.cash).toBe(1234);
    expect(texts(drain(engine, 'resume'))).toContain("can't be rebuilt");
    // a broken session doesn't block new work… but does get cleared on request
    drain(engine, 'abandon');
    expect(engine.serialize().brokenSession).toBeNull();
    drain(engine, 'run 1');
    expect(engine.mode).toBe('mission');
  });

  it('garbage and unknown versions never crash and start fresh with a note', () => {
    for (const raw of ['nope', 42, [], { version: 99, profile: {} }, { version: 2, profile: 'x', settings: null, session: { v: 2 } }]) {
      const { engine, boot } = load(raw);
      expect(engine.mode).toBe('home');
      if (typeof raw === 'object' && raw && 'version' in raw && raw.version === 99) expect(boot).toContain('not supported');
      expect(engine.profile.cash).toBe(0);
    }
  });

  it('v2 saves round-trip a parked run through two reloads', () => {
    const e = new GameEngine({ fast: true });
    bootToHome(e);
    drain(e, 'tutorial');
    drain(e, 'scan');
    settle(e);
    let blob = clone(e.serialize());
    for (let i = 0; i < 2; i++) {
      const next = new GameEngine({ fast: true, save: blob });
      bootToHome(next);
      blob = clone(next.serialize());
    }
    expect(blob.session?.scanned).toBe(true);
  });
});
