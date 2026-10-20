import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/game.js';
import {
  campaignDescriptor,
  customDescriptor,
  dailyDescriptor,
  decodeShareCode,
  encodeShareCode,
  MAX_SEED_LENGTH,
} from '../src/identity.js';
import { buildValidatedMission, drawSchedule, validateSpec } from '../src/validate.js';
import { generateFor } from '../src/missions.js';
import { formatSeed } from '../src/rng.js';
import type { EngineEvent, MissionDescriptor } from '../src/types.js';
import { bootToHome, drain } from './helpers.js';

const texts = (ev: EngineEvent[]) => ev.filter((e) => e.t === 'print').map((e) => (e as { text: string }).text).join('\n');

function engineWith(contractsDone: number): GameEngine {
  const e = new GameEngine({
    fast: true,
    save: { version: 2, profile: { contractsDone, tutorialDone: true, xp: contractsDone * 500 }, settings: {}, history: [], session: null },
  });
  bootToHome(e);
  return e;
}

/** Everything that defines the network a player meets. */
function fingerprint(d: MissionDescriptor): string {
  const s = new GameEngine({ fast: true }).specFor(d);
  return JSON.stringify({ nodes: s.nodes, edges: s.edges, objective: s.objective, answers: s.puzzleAnswers, modifier: s.modifier });
}

function flipSeedChar(code: string): string {
  const parts = code.split('-');
  const seed = parts[2]!;
  parts[2] = (seed[0] === 'A' ? 'B' : 'A') + seed.slice(1);
  return parts.join('-');
}

describe('F06 — share codes', () => {
  const seeds = [
    'ALPHA',
    'neon Harbor',
    'MiXeD-CaSe_seed.with/punct?!&',
    'Ünïcødé ☃ 雪 🚀',
    'x'.repeat(MAX_SEED_LENGTH),
    '  spaced  seed  ',
  ];

  it('round-trips long, mixed-case, punctuated and Unicode seeds exactly', () => {
    for (const seed of seeds) {
      for (const tier of [1, 4, 10]) {
        const d = customDescriptor(seed, tier);
        const code = encodeShareCode(d);
        expect(code).toMatch(/^CG1-\d[CXD]\d\d[LF][FDU][0NP]-[A-Z2-7]+-[A-Z2-7]{4}$/);
        const back = decodeShareCode(code);
        expect(back.ok, seed).toBe(true);
        if (back.ok) expect(back.descriptor).toEqual(d);
        // lower-case and stray whitespace (chat clients) still decode
        const sloppy = decodeShareCode(`  ${code.toLowerCase().replace(/-/, '- ')} `);
        expect(sloppy.ok).toBe(true);
      }
    }
    for (const d of [campaignDescriptor(1), campaignDescriptor(10), dailyDescriptor('2026-10-20')]) {
      const back = decodeShareCode(encodeShareCode(d));
      expect(back.ok && back.descriptor).toEqual(d);
    }
  });

  it('rejects malformed, corrupted and unsupported codes with a reason, never throwing', () => {
    const good = encodeShareCode(customDescriptor('ALPHA', 5));
    const cases: [string, string][] = [
      ['', 'malformed'],
      ['hello', 'malformed'],
      ['CG1-2X05', 'malformed'],
      [good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A'), 'checksum'],
      [flipSeedChar(good), 'checksum'],
      [good.replace(/^CG1/, 'CG9'), 'unsupported-format'],
    ];
    for (const [code, reason] of cases) {
      const r = decodeShareCode(code);
      expect(r.ok, code).toBe(false);
      if (!r.ok) expect(r.reason, code).toBe(reason);
    }
    // a well-formed code for an unknown generation (checksum recomputed by the forger)
    const engine = engineWith(0);
    const out = texts(drain(engine, 'run CG1-9X05FF0-IFGECSA-ZZZZ'));
    expect(out).toContain("can't use that code");
    expect(engine.mode).toBe('home');
  });

  it('the decorative label is not the identity: `share` prints the exact code', () => {
    const d = campaignDescriptor(1);
    expect(formatSeed(d.seed)).not.toBe(d.seed);
    const engine = engineWith(0);
    drain(engine, 'run 1');
    const out = texts(drain(engine, 'share'));
    expect(out).toContain(encodeShareCode(d));
  });

  it('a code reproduces the same network on profiles with different progress', () => {
    const d = customDescriptor('cross-profile', 7);
    const code = encodeShareCode(d);
    const rookie = engineWith(0);
    const vet = engineWith(9);
    drain(rookie, `run ${code}`);
    drain(vet, `run code ${code}`);
    expect(rookie.getState().mission!.code).toBe(code);
    expect(vet.getState().mission!.code).toBe(code);
    const nodes = (e: GameEngine) => JSON.stringify(e.getState().mission!.nodes.map((n) => [n.id, n.ip, n.security, n.lockFamily, n.neighbors]));
    expect(nodes(rookie)).toBe(nodes(vet));
    // a bare seed is a complete identity too: tier defaults to 4, never your progress
    const a = engineWith(0);
    const b = engineWith(9);
    drain(a, 'run seed same seed');
    drain(b, 'run seed same seed');
    expect(a.getState().mission!.code).toBe(b.getState().mission!.code);
  });

  it('a seed whose first draw fails validation resolves to the same redraw on every retry', () => {
    // find a descriptor whose first draw does not validate
    let target: MissionDescriptor | null = null;
    for (let i = 0; i < 200 && !target; i++) {
      const d = customDescriptor(`redraw-${i}`, 9);
      if (!validateSpec(generateFor(d)).ok) target = d;
    }
    expect(target, 'expected at least one redraw in 200 tier-9 seeds').not.toBeNull();
    const d = target!;
    const spec = buildValidatedMission(d);
    expect(spec.draw.seed).not.toBe(d.seed);
    expect(drawSchedule(d).some((x) => x.seed === spec.draw.seed)).toBe(true);
    const code = encodeShareCode(d);
    const engine = engineWith(0);
    drain(engine, `run ${code}`);
    const first = fingerprint(d);
    drain(engine, 'disconnect');
    drain(engine, ''); // retry
    expect(engine.getState().mission!.code).toBe(code);
    expect(fingerprint(d)).toBe(first);
    // and a resumed run rebuilds the stored draw without re-validating
    const blob = JSON.parse(JSON.stringify(engine.serialize()));
    expect(blob.session.draw).toEqual(spec.draw);
  });

  it('a locked campaign contract played from a code is practice and cannot clear the board', () => {
    const engine = engineWith(0);
    const out = texts(drain(engine, `run ${encodeShareCode(campaignDescriptor(5))}`));
    expect(out).toContain('practice run');
    expect(engine.getState().mission!.practice).toBe(true);
  });

  it('a hand-built "campaign" code with a different plan is practice', () => {
    const engine = engineWith(4);
    const fake: MissionDescriptor = { ...campaignDescriptor(5), objective: 'flagged' };
    drain(engine, `run ${encodeShareCode(fake)}`);
    expect(engine.getState().mission!.practice).toBe(true);
  });
});
