import { describe, expect, it } from 'vitest';
import { Bridge } from './engine/bridge.js';
import { TELEMETRY_DEFAULT } from '@cybergrid/engine';
import type { SaveBlob } from '@cybergrid/engine';

/**
 * Headless smoke test over the app-side bridge: the exact event-routing layer the
 * React UI depends on (print queue → terminal, fx queue → audio/juice, snapshot
 * bumps → HUD). No DOM involved.
 */

function makeSave(): SaveBlob {
  return {
    version: 1,
    profile: { cash: 0, xp: 0, contractsDone: 0, tutorialDone: true, upgrades: {}, telemetry: { ...TELEMETRY_DEFAULT } },
    settings: { volume: 0.8, muted: false, crt: true, motion: true },
    history: [],
    session: null,
  };
}

describe('Bridge event routing', () => {
  it('routes engine events into the UI queues and bumps the snapshot', () => {
    const bridge = new Bridge({ load: () => makeSave(), save: () => {} });
    let versions = 0;
    bridge.subscribe(() => versions++);

    // engine starts in boot; any input skips to home
    bridge.submit('skip');
    expect(bridge.snapshot.mode).toBe('home');
    expect(bridge.printQueue.some((e) => e.t === 'print')).toBe(true);
    expect(versions).toBeGreaterThan(0);

    bridge.printQueue.length = 0;
    bridge.submit('contracts');
    expect(bridge.snapshot.suggest).toContain('run 1');
    expect(bridge.printQueue.length).toBeGreaterThan(0);

    // start a contract: handler chat + sfx + state arrive
    bridge.printQueue.length = 0;
    bridge.handlerQueue.length = 0;
    bridge.fxQueue.length = 0;
    bridge.submit('run 1');
    expect(bridge.snapshot.mode).toBe('mission');
    expect(bridge.snapshot.mission).not.toBeNull();
    expect(bridge.handlerQueue.length).toBeGreaterThanOrEqual(1);
    expect(bridge.fxQueue.some((f) => f.kind === 'sfx')).toBe(true);
  });

  it('tick drives trace creep into the snapshot and the trace event stream', () => {
    const bridge = new Bridge({ load: () => makeSave(), save: () => {} });
    bridge.submit('skip');
    bridge.submit('run 1');
    let bumps = 0;
    const seen = bridge.snapshot.mission!.trace;
    bridge.subscribe(() => bumps++);
    for (let i = 0; i < 80; i++) bridge.frame(100); // 8s of creep ≈ +1.2 trace
    expect(bumps).toBeGreaterThan(0); // trace events bump the HUD
    expect(bridge.snapshot.mission!.trace).toBeGreaterThanOrEqual(seen);
    expect(bridge.snapshot.mission!.trace).toBeLessThan(10); // creep is slow
  });

  it('focusNode prints read-only intel and never acts for the player', () => {
    const bridge = new Bridge({ load: () => makeSave(), save: () => {} });
    bridge.submit('skip');
    bridge.submit('run 1');
    bridge.submit('scan');
    bridge.frame(50);
    bridge.printQueue.length = 0;
    const nodeId = bridge.snapshot.mission!.nodes[0]!.id;
    bridge.focusNode(nodeId);
    const texts = bridge.printQueue
      .filter((e) => e.t === 'print')
      .map((e) => (e as { text: string }).text);
    expect(texts.length).toBeGreaterThan(0);
    expect(bridge.snapshot.mode).toBe('mission');
    expect(bridge.snapshot.mission!.currentNodeId).toBe(nodeId);
  });

  it('serialize→persist round-trips through the storage adapter', () => {
    let saved: SaveBlob | null = null;
    const bridge = new Bridge({ load: () => null, save: (b) => (saved = b) });
    bridge.submit('skip');
    bridge.submit('settings volume 0.25');
    expect(saved).not.toBeNull();
    expect(saved!.settings.volume).toBe(0.25);
  });
});
