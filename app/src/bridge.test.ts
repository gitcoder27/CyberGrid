import { describe, expect, it } from 'vitest';
import { Bridge, GUIDANCE_RESET } from './engine/bridge.js';
import { createLocalStorageAdapter, CORRUPT_KEY, LEGACY_KEY, SAVE_KEY } from './persistence/storage.js';
import type { SaveBlob } from '@cybergrid/engine';

/**
 * Headless tests over the app-side bridge and storage adapter: the exact
 * event-routing layer the React UI depends on. No DOM involved.
 */

const v1Save = () => ({
  version: 1,
  profile: { cash: 0, xp: 0, contractsDone: 0, tutorialDone: true, upgrades: {} },
  settings: { volume: 0.8, muted: false, crt: true, motion: true },
  history: [],
  session: null,
});

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('Bridge event routing', () => {
  it('a finished run clears the Broker panel, then posts the debrief there', () => {
    const bridge = new Bridge({ load: () => v1Save(), save: () => {} });
    bridge.submit('', { echo: false });
    bridge.submit('run 1');
    bridge.handlerQueue.length = 0;
    bridge.submit('disconnect');
    const reset = bridge.handlerQueue.indexOf(GUIDANCE_RESET);
    expect(reset).toBe(0);
    // "short delivery. no sticker." — the Broker's line on an early exit
    expect(bridge.handlerQueue.slice(1).some((m) => m.includes('short delivery'))).toBe(true);
  });

  it('routes engine events into the UI queues, transcript and snapshot', () => {
    const bridge = new Bridge({ load: () => v1Save(), save: () => {} });
    let versions = 0;
    bridge.subscribe(() => versions++);
    bridge.submit('', { echo: false });
    expect(bridge.snapshot.mode).toBe('home');
    expect(bridge.printQueue.some((e) => e.t === 'print')).toBe(true);
    expect(versions).toBeGreaterThan(0);

    bridge.submit('contracts');
    expect(bridge.snapshot.suggest).toContain('run 1');
    expect(bridge.transcript.some((l) => l.text.endsWith('$ contracts'))).toBe(true);
    expect(bridge.transcript.some((l) => l.text.includes('THE BOARD'))).toBe(true);

    bridge.handlerQueue.length = 0;
    bridge.fxQueue.length = 0;
    bridge.submit('run 1');
    expect(bridge.snapshot.mode).toBe('mission');
    expect(bridge.handlerQueue.length).toBeGreaterThanOrEqual(1);
    expect(bridge.fxQueue.some((f) => f.kind === 'sfx')).toBe(true);
    expect(bridge.announcement.text).toContain('Mission started');
  });

  it('tick drives trace creep into the snapshot', () => {
    const bridge = new Bridge({ load: () => v1Save(), save: () => {} });
    bridge.submit('', { echo: false });
    bridge.submit('run 1');
    const seen = bridge.snapshot.mission!.traceExact;
    for (let i = 0; i < 80; i++) bridge.frame(100);
    bridge.refresh();
    expect(bridge.snapshot.mission!.traceExact).toBeGreaterThan(seen);
    expect(bridge.snapshot.mission!.trace).toBeLessThan(10);
  });

  it('composeInput places a command for the player and never executes it', () => {
    const bridge = new Bridge({ load: () => v1Save(), save: () => {} });
    bridge.submit('', { echo: false });
    bridge.submit('run 1');
    const before = JSON.stringify(bridge.engine.serialize().session);
    bridge.composeInput('breach 10.0.0.1');
    expect(bridge.compose?.text).toBe('breach 10.0.0.1');
    expect(JSON.stringify(bridge.engine.serialize().session)).toBe(before);
  });

  it('progress frames stay out of the transcript', () => {
    const bridge = new Bridge({ load: () => v1Save(), save: () => {} });
    bridge.submit('', { echo: false });
    bridge.submit('tutorial');
    for (const cmd of ['scan', 'breach 10.0.0.12', 'input 16', 'ls', 'cd srv', 'download ledger.dat']) {
      bridge.submit(cmd);
      for (let i = 0; i < 30; i++) bridge.frame(100);
    }
    expect(bridge.transcript.some((l) => l.text.includes('download complete'))).toBe(true);
    expect(bridge.transcript.some((l) => /░/.test(l.text))).toBe(false);
  });
});

describe('localStorage adapter', () => {
  it('reads a v1 save when no v2 exists, writes v2, and keeps the v1 copy as a backup', () => {
    const store = new MemoryStorage();
    store.setItem(LEGACY_KEY, JSON.stringify({ ...v1Save(), profile: { ...v1Save().profile, cash: 777 } }));
    const adapter = createLocalStorageAdapter(store);
    const bridge = new Bridge(adapter);
    expect(bridge.engine.profile.cash).toBe(777);
    bridge.persist();
    const v2 = JSON.parse(store.getItem(SAVE_KEY)!) as SaveBlob;
    expect(v2.version).toBe(2);
    expect(v2.profile.cash).toBe(777);
    expect(store.getItem(LEGACY_KEY)).not.toBeNull();
    // next load prefers v2
    store.setItem(LEGACY_KEY, JSON.stringify({ ...v1Save(), profile: { ...v1Save().profile, cash: 1 } }));
    expect(new Bridge(createLocalStorageAdapter(store)).engine.profile.cash).toBe(777);
  });

  it('a corrupt v2 save is backed up before it can be overwritten', () => {
    const store = new MemoryStorage();
    store.setItem(SAVE_KEY, '{not json');
    const bridge = new Bridge(createLocalStorageAdapter(store));
    expect(bridge.engine.loadNotes.join(' ')).toContain('unreadable');
    expect(store.getItem(CORRUPT_KEY)).toBe('{not json');
  });

  it('settings persist through the adapter', () => {
    let saved: SaveBlob | null = null;
    const bridge = new Bridge({ load: () => null, save: (b) => (saved = b) });
    bridge.submit('', { echo: false });
    bridge.submit('settings volume 0.25');
    expect(saved!.settings.volume).toBe(0.25);
  });
});
