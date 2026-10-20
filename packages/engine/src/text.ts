import type { Cls, EngineEvent, MissionSpec } from './types.js';
import { formatSeed } from './rng.js';

/** Presentation helpers: pure text, no game rules. */

export function print(text: string, cls?: Cls, style?: 'type' | 'instant'): EngineEvent {
  return { t: 'print', text, cls, style };
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function fmtSeconds(s: number): string {
  const total = Math.max(0, Math.round(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

export function homeBanner(): string {
  return [
    '┌─────────────────────────────────────────────────┐',
    '│   C Y B E R G R I D          burner terminal    │',
    '│   the grid keeps the ledger. you keep the cut.  │',
    '└─────────────────────────────────────────────────┘',
  ].join('\n');
}

/** Decorative banner. The seed label here is flavor; `share` prints the exact code. */
export function missionBanner(spec: MissionSpec, practice: boolean): string {
  const d = spec.descriptor;
  const kindLabel =
    d.mode === 'tutorial'
      ? 'MISSION 0 — WARM-UP'
      : d.mode === 'campaign'
        ? `CONTRACT #${spec.index}${practice ? ' · PRACTICE' : ''}`
        : d.mode === 'daily'
          ? `DAILY ${d.seed.replace('DAILY-', '')}${practice ? ' · PRACTICE' : ' · RECORDED'}`
          : `CUSTOM · TIER ${d.tier}`;
  const line1 = `MISSION: ${spec.name.toUpperCase()}`.slice(0, 47).padEnd(47, ' ');
  const line2 = (d.mode === 'tutorial' ? kindLabel : `${kindLabel} · ${formatSeed(d.seed)}`).slice(0, 47).padEnd(47, ' ');
  return [
    '┌─────────────────────────────────────────────────┐',
    `│ ${line1} │`,
    `│ ${line2} │`,
    '└─────────────────────────────────────────────────┘',
  ].join('\n');
}

/** The campaign ending (E04/F07): short, shown once, replayable via `epilogue`. */
export const EPILOGUE: { text: string; cls: Cls }[] = [
  { text: '───────────────────── SECURE CHANNEL ─────────────────────', cls: 'dim' },
  { text: 'Broker: That was the last contract on the board.', cls: 'handler' },
  { text: 'Broker: Ten jobs. Ten networks that still think they had a quiet year.', cls: 'handler' },
  { text: 'Broker: You want to know who the client was? So did I. The escrow came', cls: 'handler' },
  { text: '        from an account with your terminal\'s MAC address on it.', cls: 'handler' },
  { text: 'Broker: Relax. Somebody wanted to see if you were good. You are.', cls: 'handler' },
  { text: 'Broker: The board\'s empty, but the wire never is. Dailies drop at', cls: 'handler' },
  { text: '        midnight UTC. Custom jobs whenever you like. I\'ll be listening.', cls: 'handler' },
  { text: '[★] CAMPAIGN COMPLETE — the grid knows your handle now.', cls: 'accent' },
  { text: '    `daily` · `run seed <anything>` · `run <n>` to replay · `records`', cls: 'dim' },
  { text: '──────────────────────────────────────────────────────────', cls: 'dim' },
];
