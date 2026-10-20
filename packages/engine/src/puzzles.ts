import { CONFIG } from './config.js';
import type { Rng } from './rng.js';
import type { PuzzleAnswer, PuzzleState, PuzzleView } from './types.js';

/**
 * The three MVP puzzle families (PRD §8): sequence completion, port-knock memory,
 * cipher lock. Puzzles are generated deterministically from the mission RNG stream,
 * graded headlessly, and always escapable via `skip` (trace) or `hint` (cash).
 */

/* ------------------------------ generation ------------------------------ */

interface SequenceRule {
  key: string;
  rule: string;
  next: (terms: number[]) => number;
}

const SEQUENCE_RULES: Record<string, SequenceRule> = {
  arith: {
    key: 'arith',
    rule: 'constant step',
    next: (t) => {
      const d = t[1]! - t[0]!;
      return t[t.length - 1]! + d;
    },
  },
  geo: {
    key: 'geo',
    rule: 'constant ratio',
    next: (t) => {
      const r = t[1]! / t[0]!;
      return Math.round(t[t.length - 1]! * r);
    },
  },
  fib: {
    key: 'fib',
    rule: 'each term is the sum of the previous two',
    next: (t) => t[t.length - 1]! + t[t.length - 2]!,
  },
  square: {
    key: 'square',
    rule: 'perfect squares',
    next: (t) => {
      const n = Math.round(Math.sqrt(t[t.length - 1]!));
      return (n + 1) * (n + 1);
    },
  },
};

export function generateSequence(rng: Rng, security: 1 | 2 | 3): NonNullable<PuzzleState['sequence']> {
  const pool: string[] =
    security === 1 ? ['arith', 'geo'] : security === 2 ? ['geo', 'fib', 'square'] : ['fib', 'square', 'geo'];
  const key = rng.pick(pool);
  const rule = SEQUENCE_RULES[key]!;
  let terms: number[];
  switch (key) {
    case 'arith': {
      const start = rng.int(2, 12);
      const d = rng.int(2, security === 1 ? 6 : 11);
      terms = [start, start + d, start + 2 * d, start + 3 * d];
      break;
    }
    case 'geo': {
      const start = rng.int(1, 4);
      const r = rng.pick(security === 1 ? [2, 2, 3] : [2, 3, 4]);
      terms = [start, start * r, start * r * r, start * r * r * r];
      break;
    }
    case 'fib': {
      const a = rng.int(1, 5);
      const b = rng.int(2, 7);
      terms = [a, b, a + b, a + 2 * b];
      break;
    }
    default: {
      const n0 = rng.int(2, 6);
      terms = [n0 * n0, (n0 + 1) * (n0 + 1), (n0 + 2) * (n0 + 2), (n0 + 3) * (n0 + 3)];
      break;
    }
  }
  return { terms, answer: rule.next(terms), rule: rule.rule };
}

export function generateKnock(rng: Rng, tier: number): number[] {
  const clampedTier = Math.max(0, Math.min(CONFIG.puzzle.knockLengthByTier.length - 1, tier));
  const len = CONFIG.puzzle.knockLengthByTier[clampedTier]!;
  const pool = CONFIG.puzzle.knockPortPool;
  const ports: number[] = [];
  while (ports.length < len) {
    const p = rng.pick(pool);
    if (!ports.includes(p)) ports.push(p);
  }
  return ports;
}

const CIPHER_WORDS: string[][] = [
  // tier 0 — short, common
  ['GHOST', 'CIPHER', 'ORACLE', 'VIPER', 'SIREN', 'BLADE', 'RAVEN'],
  // tier 1 — longer
  ['FIREWALL', 'BLACKICE', 'PAYLOAD', 'UPLINK', 'TERMINAL', 'OVERSEER'],
  // tier 2 — longest, scariest
  ['INTRUSION', 'BACKDOOR', 'NIGHTFALL', 'COUNTERSPY', 'DARKNET', 'KEYSTONE'],
];

export function generateCipher(rng: Rng, security: 1 | 2 | 3): NonNullable<PuzzleState['cipher']> {
  const tier = Math.min(2, security - 1);
  const word = rng.pick(CIPHER_WORDS[tier]!);
  const shift = rng.int(1, 25);
  return { word, shift, hinted: false };
}

export function caesar(text: string, shift: number): string {
  return text.replace(/[A-Z]/g, (ch) => {
    const c = ((ch.charCodeAt(0) - 65 + shift) % 26 + 26) % 26;
    return String.fromCharCode(65 + c);
  });
}

/** Build the runtime puzzle for a node from its generator answer key. */
export function instantiatePuzzle(
  answer: PuzzleAnswer,
  nodeId: string,
  security: 1 | 2 | 3,
  timeLimit: number,
  forcedSuccess: boolean
): PuzzleState {
  const base: PuzzleState = {
    family: answer.family,
    nodeId,
    security,
    timeLimit,
    elapsed: 0,
    attempts: 0,
    forcedSuccess,
  };
  switch (answer.family) {
    case 'sequence':
      return {
        ...base,
        sequence: { terms: answer.terms, answer: answer.answer, rule: answer.rule },
      };
    case 'portknock':
      return { ...base, knock: { ports: answer.ports, entered: [], showLeft: CONFIG.puzzle.knockShowSeconds } };
    case 'cipher':
      return { ...base, cipher: { word: answer.word, shift: answer.shift, hinted: false } };
  }
}

/* -------------------------------- grading -------------------------------- */

export type Grade = 'correct' | 'wrong';

export function gradeSequence(p: PuzzleState, rawInput: string): Grade {
  const n = Number(rawInput.trim().replace(/[^\d-]/g, ''));
  if (!Number.isFinite(n) || rawInput.trim() === '') return 'wrong';
  return n === p.sequence!.answer ? 'correct' : 'wrong';
}

export function gradeKnock(p: PuzzleState, ports: number[]): Grade {
  const want = p.knock!.ports;
  if (ports.length !== want.length) return 'wrong';
  for (let i = 0; i < want.length; i++) {
    if (ports[i] !== want[i]) return 'wrong';
  }
  return 'correct';
}

export function gradeCipher(p: PuzzleState, rawInput: string): Grade {
  const word = rawInput.trim().toUpperCase().replace(/[^A-Z]/g, '');
  return word === p.cipher!.word ? 'correct' : 'wrong';
}

/* ------------------------------- presentation ------------------------------ */

export function puzzlePrompt(p: PuzzleState): string {
  switch (p.family) {
    case 'sequence':
      return `Packet interval lock: ${p.sequence!.terms.map((t) => `[${t}]`).join(' ')} [??] — \`input <n>\``;
    case 'portknock': {
      const visible = p.knock!.showLeft > 0;
      return visible
        ? `Knock sequence glowing: ${p.knock!.ports.join(' · ')}`
        : `Ports dark. Repeat the sequence from memory: \`knock <p1> <p2> ...\``;
    }
    case 'cipher':
      return `Cipher plaque: "${caesar(p.cipher!.word, p.cipher!.shift)}" — Caesar-shifted. Decode: \`input <word>\``;
  }
}

export const FAMILY_LABEL: Record<PuzzleState['family'], string> = {
  sequence: 'packet interval lock',
  portknock: 'knock sequence',
  cipher: 'cipher plaque',
};

/** The decoding strip shown once the wheel offset is known. */
export function cipherWheel(shift: number): string {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return `${caesar(alpha, shift)}\n${alpha}`;
}

export function puzzleView(p: PuzzleState): PuzzleView {
  return {
    family: p.family,
    prompt: puzzlePrompt(p),
    timeLimit: p.timeLimit,
    timeLeft: Math.max(0, p.timeLimit - p.elapsed),
    attempts: p.attempts,
    knockPortsVisible: p.family === 'portknock' ? p.knock!.showLeft > 0 : undefined,
    knockPorts: p.family === 'portknock' ? p.knock!.ports : undefined,
    cipherText: p.family === 'cipher' ? caesar(p.cipher!.word, p.cipher!.shift) : undefined,
  };
}

/** The `hint` command text per family (PRD §8: hint costs cash, never a wall). */
export function puzzleHint(p: PuzzleState): string {
  switch (p.family) {
    case 'sequence':
      return `hint › pattern: ${p.sequence!.rule}.`;
    case 'portknock':
      return `hint › the lock buffer re-broadcasts the sequence once. Watch the glow.`;
    case 'cipher':
      return `hint › wheel offset ${p.cipher!.shift}: shift each plaque letter BACK by ${p.cipher!.shift}. It starts "${p.cipher!.word.slice(0, 2)}…". (strip is on your lock panel)`;
    default:
      return '';
  }
}
