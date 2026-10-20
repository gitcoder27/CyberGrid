import { CONFIG } from '@cybergrid/engine';
import type { EngineEvent } from '@cybergrid/engine';

/** ANSI helpers (truecolor; the permanent color language of PRD §13). */
const COLORS: Record<string, string> = {
  good: '38;2;61;252;154',
  bad: '38;2;255;77;106',
  warn: '38;2;255;194;77',
  info: '38;2;200;211;224',
  dim: '38;2;120;136;163',
  accent: '38;2;87;215;255',
  sys: '38;2;167;139;250',
  handler: '38;2;255;176;110',
  banner: '38;2;255;95;162;1',
  loot: '38;2;61;252;154;1',
  log: '38;2;196;181;110',
  echo: '38;2;145;160;185',
};

const RESET = '\x1b[0m';
const CLEAR_LINE = '\r\x1b[2K';

function colorFor(cls?: string): string {
  return cls && COLORS[cls] ? `\x1b[${COLORS[cls]}m` : RESET;
}

export type Xterm = {
  write(data: string): void;
  clear(): void;
  scrollToBottom(): void;
};

/**
 * Owns the terminal *output* pipeline. Input lives in a native command line
 * (CommandLine.tsx), so xterm only ever renders history. Lines type out at
 * ~2ms/char when the `typing` setting is on; any keypress flushes instantly.
 * A transfer's progress bar rewrites one line in place.
 */
export class TerminalWriter {
  private queue: EngineEvent[] = [];
  private pending = '';
  private lastDrain = performance.now();
  private flushNow = false;
  /** True while the last written line is a progress bar we may overwrite. */
  private progressLine = false;
  private timer: number | null = null;

  constructor(
    private term: Xterm,
    private typing: () => boolean
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

  enqueue(e: EngineEvent[]): void {
    this.queue.push(...e);
  }

  get idle(): boolean {
    return this.queue.length === 0 && !this.pending;
  }

  private tick(): void {
    const now = performance.now();
    const elapsed = now - this.lastDrain;
    this.lastDrain = now;
    let budget = this.flushNow || !this.typing() ? Infinity : Math.max(1, Math.floor(elapsed / CONFIG.ui.typeMsPerChar));
    this.flushNow = false;
    while (budget > 0) {
      if (this.pending) {
        const take = Math.min(budget, this.pending.length);
        this.term.write(this.pending.slice(0, take));
        this.pending = this.pending.slice(take);
        budget -= take;
        if (this.pending) return;
        this.term.write(RESET + '\r\n');
        budget -= 1;
        continue;
      }
      const next = this.queue.shift();
      if (!next) break;
      this.ingest(next, budget === Infinity);
      this.lastDrain = now;
    }
  }

  private endProgress(): void {
    if (this.progressLine) {
      this.term.write('\r\n');
      this.progressLine = false;
    }
  }

  private ingest(e: EngineEvent, instant: boolean): void {
    switch (e.t) {
      case 'print': {
        this.endProgress();
        const cls = e.cls ?? 'info';
        const lines = e.text.split('\n');
        if (instant || e.style === 'instant' || e.text.length > CONFIG.ui.instantAboveChars || lines.length > 1) {
          for (const line of lines) this.term.write(colorFor(cls) + line + RESET + '\r\n');
        } else {
          this.term.write(colorFor(cls));
          this.pending = e.text;
        }
        this.term.scrollToBottom();
        break;
      }
      case 'progress': {
        const cells = Math.round(e.pct / 10);
        const bar = '█'.repeat(cells) + '░'.repeat(10 - cells);
        this.term.write(CLEAR_LINE + colorFor('accent') + `  ${e.label} ${bar} ${e.pct}%` + RESET);
        this.progressLine = e.pct < 100;
        if (e.pct >= 100) this.term.write('\r\n');
        this.term.scrollToBottom();
        break;
      }
      case 'clear': {
        this.progressLine = false;
        this.term.write('\x1b[2J\x1b[3J\x1b[H');
        this.term.clear();
        break;
      }
      default:
        break;
    }
  }
}
