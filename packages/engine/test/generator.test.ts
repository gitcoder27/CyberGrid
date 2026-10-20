import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { buildValidatedMission, drawSchedule, MissionUnavailableError, playOracle, routesFor, simulatePerfectRun, validateSpec } from '../src/validate.js';
import { contractCount, generateFor, generateMission } from '../src/missions.js';
import { generateMissionV1 } from '../src/gen/v1.js';
import { generateSafeTemplate } from '../src/gen/v2.js';
import { campaignDescriptor, customDescriptor, dailyDescriptor } from '../src/identity.js';
import { distances, neighbors } from '../src/graph.js';
import { objectiveNodeIds } from '../src/objectives.js';
import { tutorialMission } from '../src/tutorial.js';
import { walkSpecFiles } from '../src/vfs.js';
import type { MissionDescriptor, MissionSpec, PuzzleFamily } from '../src/types.js';

const fingerprints = JSON.parse(readFileSync(new URL('./fixtures/v1-fingerprints.json', import.meta.url), 'utf8')) as Record<string, string>;
const fp = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

describe('mission generation (PRD §15)', () => {
  it('same descriptor + draw → byte-identical mission', () => {
    for (const d of [campaignDescriptor(1), campaignDescriptor(7), customDescriptor('7F3K-09XA', 9), dailyDescriptor('2026-10-20')]) {
      expect(JSON.stringify(generateFor(d))).toBe(JSON.stringify(generateFor(d)));
    }
  });

  it('different seeds → different missions', () => {
    expect(JSON.stringify(generateMission(5, 'SEED-A'))).not.toBe(JSON.stringify(generateMission(5, 'SEED-B')));
  });

  it('contracts scale: later contracts have more nodes and higher security', () => {
    const m1 = generateFor(campaignDescriptor(1));
    const m10 = generateFor(campaignDescriptor(10));
    expect(m10.nodes.length).toBeGreaterThan(m1.nodes.length);
    const maxSec = (s: MissionSpec) => Math.max(...s.nodes.map((n) => n.security));
    expect(maxSec(m10)).toBeGreaterThanOrEqual(maxSec(m1));
  });

  it('every node is reachable from the entry and entry security is 0', () => {
    for (let i = 1; i <= 10; i++) {
      for (const d of [campaignDescriptor(i), customDescriptor('GRAPH', i)]) {
        const spec = generateFor(d);
        expect(spec.nodes[0]!.security).toBe(0);
        const dist = distances(spec, 'n0');
        for (const n of spec.nodes) expect(dist.has(n.id), `${d.seed} ${n.id}`).toBe(true);
      }
    }
  });

  it('flagged objectives match the tier table and point at real target files', () => {
    for (let i = 1; i <= 10; i++) {
      const spec = generateFor(customDescriptor('FLAG', i));
      if (spec.objective.type !== 'flagged') continue;
      expect(spec.objective.required).toBe(CONFIG.generation.v2.targetsByTier[i]);
      const ids = spec.nodes.flatMap((n) => walkSpecFiles(n.root).map((f) => f.targetId)).filter(Boolean);
      for (const t of spec.objective.targetIds) expect(ids).toContain(t);
    }
  });

  it('fork topology: two approaches rejoin at a junction; vault is a dead-end side room', () => {
    const spec = generateFor(campaignDescriptor(4));
    expect(spec.descriptor.topology).toBe('fork');
    const long = spec.nodes.filter((n) => n.route === 'long');
    const hot = spec.nodes.filter((n) => n.route === 'hot');
    expect(long.length).toBe(2);
    expect(hot.length).toBe(1);
    expect(neighbors(spec, 'n0')).toEqual(expect.arrayContaining([long[0]!.id, hot[0]!.id]));
    expect(hot[0]!.security).toBeGreaterThan(long[0]!.security);
    const vault = spec.nodes.find((n) => n.vault)!;
    expect(vault).toBeTruthy();
    expect(neighbors(spec, vault.id)).toHaveLength(1);
    expect(objectiveNodeIds(spec)).not.toContain(vault.id);
  });

  it('dossier and payload objectives place their files on core nodes', () => {
    const dossier = generateFor(campaignDescriptor(5));
    expect(dossier.objective.type).toBe('dossier');
    if (dossier.objective.type === 'dossier') {
      const node = dossier.nodes.find((n) => n.id === (dossier.objective as { nodeId: string }).nodeId)!;
      expect(walkSpecFiles(node.root).some((f) => f.name === (dossier.objective as { fileName: string }).fileName)).toBe(true);
    }
    const payload = generateFor(campaignDescriptor(7));
    expect(payload.objective.type).toBe('payload');
    if (payload.objective.type === 'payload') {
      const node = payload.nodes.find((n) => n.id === (payload.objective as { nodeId: string }).nodeId)!;
      expect(node.vault).toBeFalsy();
    }
  });

  it('cipher locks always have a readable wheel tag on a neighbouring node (F04)', () => {
    let ciphers = 0;
    for (let i = 1; i <= 10; i++) {
      for (const d of [campaignDescriptor(i), customDescriptor('WHEEL', i), customDescriptor('CLUE-2', i)]) {
        const spec = generateFor(d);
        for (const n of spec.nodes) {
          if (n.puzzleFamily !== 'cipher' || n.security === 0) continue;
          ciphers++;
          const holders = neighbors(spec, n.id).filter((nb) => walkSpecFiles(spec.nodes.find((m) => m.id === nb)!.root).some((f) => f.clueFor === n.id));
          expect(holders.length, `${d.seed} ${n.id}`).toBeGreaterThan(0);
          const ans = spec.puzzleAnswers[n.id]!;
          if (ans.family !== 'cipher') continue;
          // the clue never spells the answer
          for (const nb of holders) {
            for (const f of walkSpecFiles(spec.nodes.find((m) => m.id === nb)!.root)) {
              if (f.clueFor === n.id) expect(f.content!.toUpperCase()).not.toContain(ans.word);
            }
          }
        }
      }
    }
    expect(ciphers).toBeGreaterThan(5);
  });

  it('all 3 puzzle families appear across the 10 validated contracts', () => {
    const families = new Set<PuzzleFamily>();
    for (let i = 1; i <= contractCount(); i++) {
      const spec = buildValidatedMission(campaignDescriptor(i));
      for (const n of spec.nodes.slice(1)) families.add(n.puzzleFamily);
    }
    expect(families).toEqual(new Set(['sequence', 'portknock', 'cipher']));
  });

  it('the campaign introduces forks, both new objectives and both modifiers', () => {
    const specs = Array.from({ length: 10 }, (_, i) => generateFor(campaignDescriptor(i + 1)));
    expect(specs.slice(0, 3).every((s) => s.descriptor.topology === 'chain' && !s.modifier)).toBe(true);
    expect(new Set(specs.map((s) => s.objective.type))).toEqual(new Set(['flagged', 'dossier', 'payload']));
    expect(new Set(specs.map((s) => s.modifier).filter(Boolean))).toEqual(new Set(['noisy', 'patrol']));
  });
});

describe('generation 1 is frozen (legacy identity)', () => {
  it('raw generation-1 draws match the original fingerprints', () => {
    let checked = 0;
    for (const [key, hash] of Object.entries(fingerprints)) {
      const m = /^raw:(\d+):(.*)$/.exec(key);
      if (!m) continue;
      const idx = Number(m[1]);
      let seed = m[2]!;
      let relax = 0;
      const r = /^(.*):r(\d)$/.exec(seed);
      if (r) {
        seed = r[1]!;
        relax = Number(r[2]);
      }
      expect(fp(generateMissionV1(idx, seed, relax)), key).toBe(hash);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('validated generation-1 contracts resolve to the same draw as before', () => {
    for (let i = 1; i <= 10; i++) {
      const d: MissionDescriptor = { ...campaignDescriptor(i), gen: 1, topology: 'chain', objective: 'flagged', modifier: null };
      const spec = buildValidatedMission(d);
      expect(spec.draw.seed).toBe(d.seed);
      expect(`${spec.draw.seed} ${fp(generateMissionV1(i, spec.draw.seed, spec.draw.relax))}`, `validated:${i}`).toBe(fingerprints[`validated:${i}`]);
    }
  }, 60_000);
});

describe('solvability: every shipped mission completes with margin', () => {
  it('tutorial is completable', () => {
    const sim = simulatePerfectRun(tutorialMission());
    expect(sim.busted).toBe(false);
    expect(sim.stolen).toBe(sim.required);
  });

  it('all 10 campaign contracts validate on every fork route with the stock rig', () => {
    for (let i = 1; i <= contractCount(); i++) {
      const spec = buildValidatedMission(campaignDescriptor(i));
      for (const route of routesFor(spec)) {
        const sim = playOracle(spec, { route });
        expect(sim.busted, `contract ${i} ${route} busted`).toBe(false);
        expect(sim.objectiveComplete, `contract ${i} ${route}`).toBe(true);
        expect(sim.traceMax, `contract ${i} peak`).toBeLessThan(CONFIG.escalation.bustedAt);
        expect(sim.traceEnd, `contract ${i} margin`).toBeLessThanOrEqual(CONFIG.validate.maxTrace);
        if (i <= CONFIG.validate.cleanExitRequiredThrough) expect(sim.outcome, `contract ${i} clean`).toBe('clean');
      }
    }
  }, 60_000);

  it('custom seeds and dailies validate too', () => {
    for (const d of [
      ...'ALPHA BRAVO 7F3K-09XA zz-quantum'.split(' ').flatMap((s) => [customDescriptor(s, 3), customDescriptor(s, 8)]),
      dailyDescriptor('2026-10-20'),
      dailyDescriptor('2027-02-28'),
    ]) {
      expect(validateSpec(buildValidatedMission(d)).ok, d.seed).toBe(true);
    }
  }, 60_000);

  it('validation is deterministic: the same descriptor always ships the same draw', () => {
    const d = customDescriptor('determinism', 7);
    expect(JSON.stringify(buildValidatedMission(d))).toBe(JSON.stringify(buildValidatedMission(d)));
  });

  it('failing candidates fall back through redraws to a validated safe template', () => {
    const d = customDescriptor('always-fails', 9);
    const tried: string[] = [];
    const spec = buildValidatedMission(d, {
      generate: (desc, seed, relax) => {
        tried.push(`${seed}/${relax}`);
        return generateFor(desc, seed, relax);
      },
      check: (s) => s.draw.seed.endsWith('~safe') && validateSpec(s).ok,
    });
    expect(tried).toHaveLength(drawSchedule(d).length);
    expect(spec.draw.seed).toBe(`${d.seed}~safe`);
    expect(spec.nodes.filter((n) => n.security > 0).every((n) => n.puzzleFamily === 'sequence')).toBe(true);
    expect(validateSpec(generateSafeTemplate(d)).ok).toBe(true);
  });

  it('when nothing validates, the job is refused instead of shipped unproven', () => {
    expect(() => buildValidatedMission(customDescriptor('never', 5), { check: () => false })).toThrow(MissionUnavailableError);
  });
});
