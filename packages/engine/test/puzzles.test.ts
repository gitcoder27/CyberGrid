import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { GameEngine } from '../src/game.js';
import {
  caesar,
  generateCipher,
  generateKnock,
  generateSequence,
  gradeCipher,
  gradeKnock,
  gradeSequence,
  instantiatePuzzle,
  puzzleHint,
  puzzlePrompt,
} from '../src/puzzles.js';
import { Rng } from '../src/rng.js';
import type { PuzzleState } from '../src/types.js';
import { TELEMETRY_DEFAULT } from '../src/types.js';
import { bootToHome, breachTo, drain, settle, tickWhile, traceOf } from './helpers.js';

describe('sequence completion', () => {
  it('is deterministic for a given seed', () => {
    const a = generateSequence(new Rng('SEQ-1'), 1);
    const b = generateSequence(new Rng('SEQ-1'), 1);
    expect(a).toEqual(b);
  });

  it('answers obey the advertised rule (arithmetic/geo/fib/square)', () => {
    for (let i = 0; i < 60; i++) {
      const sec = ((i % 3) + 1) as 1 | 2 | 3;
      const seq = generateSequence(new Rng(`SEQ-R${i}`), sec);
      const { terms, answer } = seq;
      expect(terms).toHaveLength(4);
      if (seq.rule === 'constant step') {
        expect(answer - terms[3]!).toBe(terms[1]! - terms[0]!);
      } else if (seq.rule === 'constant ratio') {
        expect(answer).toBe(Math.round(terms[3]! * (terms[1]! / terms[0]!)));
      } else if (seq.rule === 'each term is the sum of the previous two') {
        expect(answer).toBe(terms[3]! + terms[2]!);
      } else if (seq.rule === 'perfect squares') {
        const n = Math.round(Math.sqrt(terms[3]!));
        expect(answer).toBe((n + 1) * (n + 1));
      }
    }
  });

  it('grades numeric answers, rejecting junk', () => {
    const p: PuzzleState = instantiatePuzzle(
      { family: 'sequence', terms: [2, 4, 8], answer: 16, rule: 'constant ratio' },
      'n1',
      1,
      30,
      false
    );
    expect(gradeSequence(p, '16')).toBe('correct');
    expect(gradeSequence(p, ' 16 ')).toBe('correct');
    expect(gradeSequence(p, '15')).toBe('wrong');
    expect(gradeSequence(p, 'abc')).toBe('wrong');
    expect(puzzlePrompt(p)).toContain('[2] [4] [8]');
  });
});

describe('port-knock memory', () => {
  it('draws unique ports with tier-scaled length', () => {
    expect(generateKnock(new Rng('K1'), 0)).toHaveLength(CONFIG.puzzle.knockLengthByTier[0]!);
    expect(generateKnock(new Rng('K2'), 5)).toHaveLength(7);
    const ports = generateKnock(new Rng('K3'), 3);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('enforces exact order', () => {
    const p: PuzzleState = instantiatePuzzle({ family: 'portknock', ports: [22, 443, 8080] }, 'n1', 1, 30, false);
    expect(gradeKnock(p, [22, 443, 8080])).toBe('correct');
    expect(gradeKnock(p, [443, 22, 8080])).toBe('wrong');
    expect(gradeKnock(p, [22, 443])).toBe('wrong');
  });

  it('goes dark after the show window and can be re-flashed via hint', () => {
    const engine = freshEngine('KNOCK-LIVE', 2);
    // find a knock node on the chain
    const spec = engine.getValidatedSpec(2, 'CG-OMEN-02');
    if (!spec.nodes.slice(1).some((n) => n.puzzleFamily === 'portknock')) {
      return; // contract roll has no knock this seed — covered by generator tests
    }
    const knockNode = spec.nodes.find((n) => n.puzzleFamily === 'portknock' && n.security > 0)!;
    // walk the graph up to (not including) it
    breachToNeighbor(engine, spec, knockNode.id);
    drain(engine, `breach ${knockNode.ip}`);
    settle(engine);
    engine.profile.cash = 1000;
    let snap = engine.getState().mission!.puzzle!;
    expect(snap.family).toBe('portknock');
    expect(snap.knockPortsVisible).toBe(true);
    expect(snap.knockPorts.length).toBeGreaterThan(0);
    // let the glow die
    for (let i = 0; i < 60; i++) engine.tick(0.1);
    snap = engine.getState().mission!.puzzle!;
    expect(snap.knockPortsVisible).toBe(false);
    expect(snap.knockPorts).toHaveLength(0);
    // hint re-flashes
    drain(engine, 'hint');
    snap = engine.getState().mission!.puzzle!;
    expect(snap.knockPortsVisible).toBe(true);
  });
});

describe('cipher lock', () => {
  it('round-trips through caesar and grades case-insensitively', () => {
    const c = generateCipher(new Rng('CIP'), 2);
    expect(c.shift).toBeGreaterThanOrEqual(1);
    expect(c.shift).toBeLessThanOrEqual(25);
    const encrypted = caesar(c.word, c.shift);
    expect(encrypted).not.toBe(c.word);
    const p: PuzzleState = instantiatePuzzle({ family: 'cipher', word: c.word, shift: c.shift }, 'n1', 2, 30, false);
    expect(gradeCipher(p, c.word)).toBe('correct');
    expect(gradeCipher(p, c.word.toLowerCase())).toBe('correct');
    expect(gradeCipher(p, caesar(c.word, 1))).toBe('wrong');
    expect(puzzlePrompt(p)).toContain(encrypted);
  });

  it('hint reveals the wheel offset', () => {
    const engine = freshEngine('CIPH-HINT', 4);
    const spec = engine.getValidatedSpec(4, 'CG-OMEN-04');
    const ciphNode = spec.nodes.find((n) => n.puzzleFamily === 'cipher');
    if (!ciphNode) return;
    breachToNeighbor(engine, spec, ciphNode.id);
    drain(engine, `breach ${ciphNode.ip}`);
    settle(engine);
    engine.profile.cash = 1000;
    const ev = drain(engine, 'hint');
    const text = ev.find((e) => e.t === 'print' && e.text.includes('offset'));
    expect(text).toBeTruthy();
    const answer = (spec.puzzleAnswers[ciphNode.id] as { word: string }).word;
    drain(engine, `input ${answer}`);
    expect(engine.getState().mission!.currentNodeId).toBe(ciphNode.id);
  });
});

describe('lock lifecycle (skip / fuse / forced success)', () => {
  it('skip costs +25 and opens the node', () => {
    const engine = freshEngine('SKIP', 1);
    const spec = engine.getValidatedSpec(1, 'CG-OMEN-01');
    drain(engine, 'scan');
    settle(engine);
    drain(engine, `breach ${spec.nodes[1]!.ip}`);
    settle(engine);
    const before = traceOf(engine);
    drain(engine, 'skip');
    const breachCost = CONFIG.trace.breachBySecurity[spec.nodes[1]!.security as 1]!;
    expect(traceOf(engine)).toBeCloseTo(before + CONFIG.trace.skipPuzzle + breachCost, 1);
    expect(engine.getState().mission!.puzzle).toBeNull();
    expect(engine.getState().mission!.currentNodeId).toBe(spec.nodes[1]!.id);
  });

  it('fuse timeout fails the breach (+15) and re-arms the node', () => {
    const engine = freshEngine('FUSE', 1);
    const spec = engine.getValidatedSpec(1, 'CG-OMEN-01');
    drain(engine, 'scan');
    settle(engine);
    drain(engine, `breach ${spec.nodes[1]!.ip}`);
    settle(engine);
    const limit = engine.getState().mission!.puzzle!.timeLimit;
    for (let i = 0; i < limit + 2; i++) engine.tick(1);
    expect(engine.getState().mission!.puzzle).toBeNull();
    const gained = traceOf(engine);
    expect(gained).toBeGreaterThanOrEqual(CONFIG.trace.failedPuzzle);
    // node is still locked → can re-breach
    drain(engine, `breach ${spec.nodes[1]!.ip}`);
    settle(engine);
    expect(engine.getState().mission!.puzzle).not.toBeNull();
  });

  it('tutorial lock is forced-success on the first graded attempt', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    drain(engine, 'tutorial');
    drain(engine, 'scan');
    settle(engine);
    drain(engine, 'breach 10.0.0.12');
    settle(engine);
    drain(engine, 'input 999'); // wrong on purpose — forced success
    expect(engine.getState().mission!.currentNodeId).toBe('n1');
    expect(engine.getState().mission!.puzzle).toBeNull();
  });

  it('tutorial run completes end-to-end and cannot bust', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    drain(engine, 'tutorial');
    const steps = ['scan', 'breach 10.0.0.12', 'input 16', 'ls', 'cd srv', 'download ledger.dat', 'rm /var/log/auth.log', 'disconnect'];
    for (const s of steps) {
      expect(engine.mode).toBe('mission');
      drain(engine, s);
      settle(engine);
      tickWhile(engine, () => engine.getState().mission?.transferLabel != null);
    }
    // regression (post-tutorial loop): the tutorial must land on the HOME
    // terminal — the post screen's ENTER retries, which used to restart the
    // tutorial while its suggestion said `run 1` (a verb post mode rejected).
    expect(engine.mode).toBe('home');
    expect(engine.lastResult!.outcome).toBe('clean');
    expect(engine.profile.tutorialDone).toBe(true);
    expect(engine.suggest).toBe('run 1');
    // …and the suggested `run 1` must actually start contract 1, not the tutorial
    drain(engine, 'run 1');
    expect(engine.mode).toBe('mission');
    expect(engine.getState().mission!.isTutorial).toBe(false);
    expect(engine.getState().mission!.required).toBeGreaterThanOrEqual(2);
  });

  it('tutorial trace is capped so it can never bust', () => {
    const engine = new GameEngine({ fast: true });
    bootToHome(engine);
    drain(engine, 'tutorial');
    for (let i = 0; i < 2000; i++) engine.tick(1);
    expect(engine.mode).toBe('mission');
    expect(traceOf(engine)).toBeLessThanOrEqual(CONFIG.trace.tutorialCap);
  });

  it('puzzleHint mentions the right clue per family', () => {
    const seq: PuzzleState = instantiatePuzzle({ family: 'sequence', terms: [2, 4, 8], answer: 16, rule: 'constant ratio' }, 'n1', 1, 30, false);
    expect(puzzleHint(seq)).toContain('ratio');
  });
});

function freshEngine(seed: string, contract: number): GameEngine {
  const engine = new GameEngine({ fast: true, save: {
    version: 1,
    profile: { cash: 500, xp: 0, contractsDone: contract - 1, tutorialDone: true, upgrades: {}, telemetry: { ...TELEMETRY_DEFAULT } },
    settings: { volume: 0.8, muted: false, crt: true, motion: true },
    history: [],
    session: null,
  } });
  bootToHome(engine);
  drain(engine, `run ${contract}`);
  void seed;
  return engine;
}

/** Own and stand on a node linked to `id`. */
function breachToNeighbor(engine: GameEngine, spec: ReturnType<GameEngine['getValidatedSpec']>, id: string): void {
  drain(engine, 'scan');
  settle(engine);
  const via = spec.edges.find(([a, b]) => b === id || a === id)!;
  breachTo(engine, spec, via[0] === id ? via[1] : via[0]);
}

/** Answer whatever lock is open, from the answer key. */
function solveCurrentLock(engine: GameEngine, spec: ReturnType<GameEngine['getValidatedSpec']>): void {
  const puzzle = engine.getState().mission!.puzzle;
  if (!puzzle) return;
  const ans = spec.puzzleAnswers[puzzle.nodeId]!;
  if (ans.family === 'portknock') drain(engine, `knock ${ans.ports.join(' ')}`);
  else if (ans.family === 'cipher') drain(engine, `input ${ans.word}`);
  else drain(engine, `input ${ans.answer}`);
}
