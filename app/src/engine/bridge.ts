import { GameEngine } from '@cybergrid/engine';
import type { EngineEvent, MissionResult, Snapshot, StorageAdapter } from '@cybergrid/engine';

/**
 * Bridge — the seam between the deterministic engine and the React view layer.
 * The UI submits command strings and ticks the engine once per frame; events are
 * routed to the terminal writer, the synth, the juice layer and the
 * accessibility mirrors through queues. No game rules live here.
 */

export interface FxEvent {
  kind: 'sfx' | 'shake' | 'flash' | 'glitch';
  name?: string;
  power?: number;
  flashKind?: 'good' | 'bad' | 'alert';
}

export interface TranscriptLine {
  id: number;
  text: string;
  cls: string;
}

const TRANSCRIPT_MAX = 300;
/** Handler-queue marker: drop transient step guidance (the run it referred to is over). */
export const GUIDANCE_RESET = '\u0000reset-guidance';

export class Bridge {
  readonly engine: GameEngine;
  snapshot: Snapshot;

  /** drained by the terminal writer */
  printQueue: EngineEvent[] = [];
  /** drained by the audio + juice layers */
  fxQueue: FxEvent[] = [];
  /** drained by the handler chat panel */
  handlerQueue: string[] = [];
  /** Plain-text mirror of terminal output (screen readers, tests). Progress frames excluded. */
  transcript: TranscriptLine[] = [];
  transcriptVersion = 0;
  /** Latest short status announcement (lock opened, fuse burning, outcome…). */
  announcement = { text: '', seq: 0 };
  /** A command a HUD control wants placed in the input line (never executed). */
  compose: { text: string; seq: number } | null = null;
  lastResult: MissionResult | null = null;
  resultSeq = 0;

  private listeners = new Set<() => void>();
  private version = 0;
  private lineId = 0;

  constructor(storage: StorageAdapter, opts: { now?: () => number } = {}) {
    this.engine = new GameEngine({ storage, now: opts.now });
    this.snapshot = this.engine.getState();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Submit a command line exactly as typed. The echo goes to the transcript first. */
  submit(line: string, opts: { echo?: boolean } = {}): void {
    if (opts.echo !== false && this.snapshot.mode !== 'boot') {
      const echo = `${this.snapshot.prompt} ${line}`;
      this.printQueue.push({ t: 'print', text: echo, cls: 'echo', style: 'instant' });
      this.pushTranscript(echo, 'echo');
    }
    this.ingest(this.engine.submit(line));
    this.refresh();
  }

  /** One animation frame: advance the clock, drain events. */
  frame(dtMs: number): void {
    const events = this.engine.tick(dtMs / 1000);
    if (events.length) this.ingest(events);
  }

  /** Any key during the bust sequence: show the rest at once (result is already settled). */
  skipCutscene(): void {
    this.ingest(this.engine.skipCutscene());
    this.refresh();
  }

  persist(): void {
    this.engine.persist();
  }

  /** Place a command in the input line for the player to confirm with Enter. */
  composeInput(text: string): void {
    this.compose = { text, seq: (this.compose?.seq ?? 0) + 1 };
    this.bump();
  }

  /** App-level note in the terminal (e.g. "paused while hidden"). Not game output. */
  note(text: string): void {
    this.printQueue.push({ t: 'print', text, cls: 'dim', style: 'instant' });
    this.pushTranscript(text, 'dim');
    this.bump();
  }

  private pushTranscript(text: string, cls: string): void {
    for (const line of text.split('\n')) {
      this.transcript.push({ id: ++this.lineId, text: line, cls });
    }
    if (this.transcript.length > TRANSCRIPT_MAX) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_MAX);
    this.transcriptVersion++;
  }

  private ingest(events: EngineEvent[]): void {
    let stateChanged = false;
    // A finished run's chatter goes before the after-action lines arrive, and
    // the Broker's debrief from that batch shows in the panel as well.
    const ended = events.some((e) => e.t === 'missionEnd');
    if (ended) this.handlerQueue.push(GUIDANCE_RESET);
    for (const e of events) {
      switch (e.t) {
        case 'print':
          this.printQueue.push(e);
          this.pushTranscript(e.text, e.cls ?? 'info');
          if (ended && e.cls === 'handler') {
            const quoted = /"([^"]+)"/.exec(e.text);
            if (quoted) this.handlerQueue.push(quoted[1]!);
          }
          break;
        case 'progress':
          this.printQueue.push(e);
          break;
        case 'clear':
          this.printQueue.push(e);
          this.transcript = [];
          this.transcriptVersion++;
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
          this.pushTranscript(`broker: ${e.text}`, 'handler');
          break;
        case 'announce':
          this.announcement = { text: e.text, seq: this.announcement.seq + 1 };
          stateChanged = true;
          break;
        case 'missionEnd':
          this.lastResult = e.result;
          this.resultSeq++;
          stateChanged = true;
          break;
        case 'suggest':
        case 'trace':
        case 'state':
        case 'puzzleOpen':
        case 'puzzleClose':
          stateChanged = true;
          break;
      }
    }
    if (stateChanged) this.refresh();
  }

  /** Force a HUD refresh. */
  bump(): void {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  refresh(): void {
    this.snapshot = this.engine.getState();
    this.bump();
  }
}
