import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { buildValidatedMission, simulatePerfectRun } from '../src/validate.js';
import { contractSeed, generateMission, contractCount } from '../src/missions.js';
import { tutorialMission } from '../src/tutorial.js';
import type { PuzzleFamily } from '../src/types.js';

describe('mission generation (PRD §15)', () => {
  it('same seed → byte-identical mission', () => {
    for (const idx of [1, 4, 7, 10]) {
      const a = JSON.stringify(generateMission(idx, '7F3K-09XA'));
      const b = JSON.stringify(generateMission(idx, '7F3K-09XA'));
      expect(a).toBe(b);
    }
  });

  it('different seeds → different missions (structure differs)', () => {
    const a = JSON.stringify(generateMission(5, 'SEED-A'));
    const b = JSON.stringify(generateMission(5, 'SEED-B'));
    expect(a).not.toBe(b);
  });

  it('contracts scale: deeper contracts have more nodes and higher security', () => {
    const m1 = generateMission(1, 'SCALE');
    const m10 = generateMission(10, 'SCALE');
    expect(m10.nodes.length).toBeGreaterThan(m1.nodes.length);
    const maxSec = (nodes: typeof m1.nodes) => Math.max(...nodes.map((n) => n.security));
    expect(maxSec(m10.nodes)).toBeGreaterThanOrEqual(maxSec(m1.nodes));
  });

  it('linear chain: entry node is security 0, targets satisfy the objective', () => {
    for (let i = 1; i <= 10; i++) {
      const spec = generateMission(i, 'CHAIN');
      expect(spec.nodes[0]!.security).toBe(0);
      expect(spec.targetIds.length).toBe(spec.requiredTargets);
      const required = CONFIG.mission.targetsByIndex[i]!;
      expect(spec.requiredTargets).toBe(required);
    }
  });

  it('all 3 puzzle families appear across the 10 validated contracts', () => {
    const families = new Set<PuzzleFamily>();
    for (let i = 1; i <= contractCount(); i++) {
      const spec = buildValidatedMission(i, contractSeed(i));
      for (const n of spec.nodes.slice(1)) families.add(n.puzzleFamily);
    }
    expect(families.has('sequence')).toBe(true);
    expect(families.has('portknock')).toBe(true);
    expect(families.has('cipher')).toBe(true);
  });
});

describe('solvability: every generated mission completes with margin', () => {
  it('tutorial is completable', () => {
    const sim = simulatePerfectRun(tutorialMission());
    expect(sim.busted).toBe(false);
    expect(sim.stolen).toBe(sim.required);
  }, 20_000);

  it('all 10 fixed contracts validate (perfect run, no bust, margin ≤ 85)', () => {
    for (let i = 1; i <= contractCount(); i++) {
      const spec = buildValidatedMission(i, contractSeed(i));
      const sim = simulatePerfectRun(spec);
      expect(sim.busted, `contract ${i} busted`).toBe(false);
      expect(sim.stolen, `contract ${i} stolen`).toBeGreaterThanOrEqual(sim.required);
      expect(sim.traceEnd, `contract ${i} margin`).toBeLessThanOrEqual(CONFIG.validate.maxTrace);
      if (i <= CONFIG.validate.cleanExitRequiredThrough) {
        expect(sim.outcome, `contract ${i} clean-exit achievable`).toBe('clean');
      }
    }
  }, 120_000);

  it('custom seeds validate too', () => {
    for (const seed of 'ALPHA BRAVO 7F3K-09XA zz-quantum'.split(' ')) {
      const spec = buildValidatedMission(3, seed);
      const sim = simulatePerfectRun(spec);
      expect(sim.busted).toBe(false);
      expect(sim.stolen).toBeGreaterThanOrEqual(sim.required);
    }
  }, 60_000);
});
