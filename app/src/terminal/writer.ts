import { CONFIG } from '@cybergrid/engine';
import type { Bridge } from '../engine/bridge.js';

/** ANSI helpers (truecolor; the permanent color language of PRD §13). */
const COLORS: Record<string, string> = {
  good: '38;2;61;252;154',
  bad: '38;2;255;77;106',
  warn: '38;2;255;194;77',
  info: '38;2;200;211;224',
  dim: '38;2;91;107;133',
  accent: '38;2;87;215;255',
  sys: '38;2;167;139;250',
  handler: '38;2;255;176;110',
  banner: '38;2;255;95;162;1',
  loot: '38;2;61;252;154;1',
  log: '38;2;196;181;110',
};

const RESET = '\x1b[0m';
const CLEAR_LINE = '\r\x1b[2K';

function colorFor(cls?: string): string {
  return cls && COLORS[cls] ? `\x1b[${COLORS[cls]}m` : RESET;
}

type Xterm = {
  write(data: string): void;
  clear(): void;
  scrollToBottom(): void;
};

/**
 * Owns the terminal output pipeline: drains the bridge print queue with a
 * typewriter cadence (~2ms/char), redraws the input line, handles progress
 * rewrites. Any keypress flushes pending output instantly (PRD §13).
 */
export class TerminalWriter {
  private queue: import('@cybergrid/engine').EngineEvent[] = [];
  private pending = ''; // chars waiting to be typed out
  private lastDrain = performance.now();
  private flushNow = false;
  private cursorAtLineStart = true;
  private promptDirty = false;
  private timer: number | null = null;

  constructor(
    private term: Xterm,
    private bridge: Bridge,
    private getInput: () => string
  ) {
    this.timer = window.setInterval(() => this.tick(), 10);
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Any keypress: finish the typewriter instantly. */
  flush(): void {
    this.flushNow = true;
  }

  submit(): void {
    // move off the input line; the echo is what the user already sees
    this.term.write('\r\n');
    this.cursorAtLineStart = true;
    this.promptDirty = true;
  }

  private tick(): void {
    const now = performance.now();
    const elapsed = now - this.lastDrain;
    this.lastDrain = now;
    let budget = this.flushNow ? Infinity : Math.max(1, Math.floor(elapsed / CONFIG.ui.typeMsPerChar));
    this.flushNow = false;

    while (budget > 0) {
      if (this.pending) {
        const take = Math.min(budget, this.pending.length);
        this.writeRaw(this.pending.slice(0, take));
        this.pending = this.pending.slice(take);
        budget -= take;
        if (this.pending) return; // budget exhausted mid-line
        this.term.write(RESET + '\r\n');
        this.cursorAtLineStart = true;
        this.promptDirty = true;
        budget -= 1;
        continue;
      }
      const next = this.queue.shift();
      if (!next) break;
      this.ingest(next);
      // instant events don't consume type budget; typed lines restart the clock
      this.lastDrain = now;
    }

    if (!this.pending && !this.queue.length && this.promptDirty) {
      this.drawPrompt();
    }
  }

  private ingest(e: import('@cybergrid/engine').EngineEvent): void {
    switch (e.t) {
      case 'print': {
        if (!this.cursorAtLineStart) this.term.write(CLEAR_LINE);
        const cls = e.cls ?? 'info';
        if (e.style === 'instant') {
          const lines = e.text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            this.term.write(colorFor(cls) + lines[i] + (i < lines.length - 1 ? '\r\n' : ''));
          }
          this.term.write(RESET + '\r\n');
          this.cursorAtLineStart = true;
          this.promptDirty = true;
        } else {
          // typewriter: stage the text (long lines print whole — PRD pacing)
          if (e.text.length > CONFIG.ui.instantAboveChars) {
            this.term.write(colorFor(cls) + e.text + RESET + '\r\n');
            this.cursorAtLineStart = true;
            this.promptDirty = true;
          } else {
            this.pending = e.text;
            this.term.write(colorFor(cls));
            this.cursorAtLineStart = false;
          }
        }
        break;
      }
      case 'progress': {
        if (!this.cursorAtLineStart) this.term.write(CLEAR_LINE);
        const cells = Math.round(e.pct / 10);
        const bar = '█'.repeat(cells) + '░'.repeat(10 - cells);
        this.term.write(colorFor('accent') + `  ⇣ ${e.label} ${bar} ${e.pct}%` + RESET);
        this.cursorAtLineStart = false;
        this.term.scrollToBottom();
        break;
      }
      case 'clear': {
        this.term.write('\x1b[2J\x1b[3J\x1b[H');
        this.term.clear();
        this.cursorAtLineStart = true;
        this.promptDirty = true;
        break;
      }
      default:
        break;
    }
  }

  private writeRaw(text: string): void {
    this.term.write(text);
    this.cursorAtLineStart = false;
  }

  /** Redraw the input line: prompt + current buffer. */
  drawInput(): void {
    this.term.write(CLEAR_LINE + colorFor('dim') + this.bridge.snapshot.prompt + RESET + this.getInput());
    this.cursorAtLineStart = false;
    this.promptDirty = false;
    // The prompt is the anchor: wherever the player scrolled, the newest output
    // and the live line must be visible again once output settles (UAT fix).
    this.term.scrollToBottom();
  }

  private drawPrompt(): void {
    this.drawInput();
  }

  /** Force a prompt repaint (e.g. after TAB-candidate listing). */
  newline(): void {
    this.term.write('\r\n');
    this.cursorAtLineStart = true;
    this.promptDirty = true;
  }

  enqueue(e: import('@cybergrid/engine').EngineEvent[]): void {
    this.queue.push(...e);
  }

  get idle(): boolean {
    return this.queue.length === 0 && !this.pending;
  }
}
