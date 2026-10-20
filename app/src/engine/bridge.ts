import { GameEngine } from '@cybergrid/engine';
import type { EngineEvent, MissionResult, Snapshot } from '@cybergrid/engine';
import type { StorageAdapter } from '@cybergrid/engine';

/**
 * Bridge — the seam between the deterministic engine and the React view layer.
 * The UI submits command strings and ticks the engine once per frame; events are
 * routed to the terminal writer, the synth, and the juice layer through queues.
 */

export interface FxEvent {
  kind: 'sfx' | 'shake' | 'flash' | 'glitch';
  name?: string;
  power?: number;
  flashKind?: 'good' | 'bad' | 'alert';
}

export class Bridge {
  readonly engine: GameEngine;
  snapshot: Snapshot;

  /** drained by the terminal writer */
  printQueue: EngineEvent[] = [];
  /** drained by the audio + juice layers */
  fxQueue: FxEvent[] = [];
  /** drained by the handler chat panel */
  handlerQueue: string[] = [];
  /** set when a mission ends (HUD outcome pulse) */
  lastResult: MissionResult | null = null;
  resultSeq = 0;

  private listeners = new Set<() => void>();
  private version = 0;

  constructor(storage: StorageAdapter) {
    this.engine = new GameEngine({ storage });
    this.snapshot = this.engine.getState();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Submit a command line from the terminal. */
  submit(line: string): void {
    const events = this.engine.submit(line);
    this.ingest(events);
  }

  /** One animation frame: advance the clock, drain events. */
  frame(dtMs: number): void {
    const events = this.engine.tick(dtMs / 1000);
    if (events.length) this.ingest(events);
  }

  persist(): void {
    this.engine.persist();
  }

  /** HUD node click: focus, never act (PRD §14). Prints intel into the terminal. */
  focusNode(nodeId: string): void {
    const m = this.snapshot.mission;
    const node = m?.nodes.find((n) => n.id === nodeId);
    if (!m || !node) return;
    const lines: string[] = [];
    lines.push(`┆ ${node.hostname} (${node.ip})`);
    if (!node.scanned) {
      lines.push('┆ no recon data — run `scan`.');
    } else {
      lines.push(`┆ security tier ${node.security} · loot ~$${node.lootValue} · logs ${node.logsLeft}`);
      lines.push(`┆ status: ${node.status}${node.hasTarget ? ' · holds flagged files' : ''}`);
      if (m.watchdogNodeId === nodeId) lines.push('┆ ⚠ WATCHDOG DAEMON PRESENT — breach costs double');
    }
    for (const text of lines) {
      this.printQueue.push({ t: 'print', text, cls: 'sys', style: 'instant' });
    }
    this.bump();
  }

  private ingest(events: EngineEvent[]): void {
    let stateChanged = false;
    for (const e of events) {
      switch (e.t) {
        case 'print':
        case 'progress':
        case 'clear':
          this.printQueue.push(e);
          break;
        case 'suggest':
          // rendered as the HUD glow chip from the snapshot, not as terminal text
          stateChanged = true;
          break;
        case 'sfx':
          this.fxQueue.push({ kind: 'sfx', name: e.name });
          break;
        case 'shake':
          this.fxQueue.push({ kind: 'shake', power: e.power });
          break;
        case 'flash':
          this.fxQueue.push({ kind: 'flash', flashKind: e.kind });
          break;
        case 'glitch':
          this.fxQueue.push({ kind: 'glitch' });
          break;
        case 'handler':
          this.handlerQueue.push(e.text);
          break;
        case 'trace':
        case 'state':
          stateChanged = true;
          break;
        case 'puzzleOpen':
        case 'puzzleClose':
          stateChanged = true;
          break;
        case 'missionEnd':
          this.lastResult = e.result;
          this.resultSeq++;
          stateChanged = true;
          break;
      }
    }
    if (stateChanged) {
      this.snapshot = this.engine.getState();
      this.bump();
    }
  }

  /** Force a HUD refresh (e.g. after bridged prints). */
  bump(): void {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  refresh(): void {
    this.snapshot = this.engine.getState();
    this.bump();
  }
}
