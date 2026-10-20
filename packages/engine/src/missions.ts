import { CONFIG } from './config.js';
import { generateMissionV1, type LegacySpecV1 } from './gen/v1.js';
import { generateMissionV2, redactLegacyPlaque, wheelClue } from './gen/v2.js';
import { chainEdges } from './graph.js';
import { campaignDescriptor, contractSeed, customDescriptor } from './identity.js';
import { tutorialMission } from './tutorial.js';
import type { MissionDescriptor, MissionSpec } from './types.js';
import { Vfs } from './vfs.js';

/**
 * Mission generation front door: dispatches a descriptor to the generator of
 * its generation version. Generation is pure; validate.ts decides which draw
 * ships and the engine caches the result per descriptor.
 */
export function generateFor(desc: MissionDescriptor, drawSeed: string = desc.seed, relax = 0): MissionSpec {
  if (desc.mode === 'tutorial') return tutorialMission();
  if (desc.gen === 1) return adaptLegacySpec(generateMissionV1(desc.tier, drawSeed, relax), desc, { seed: drawSeed, relax });
  return generateMissionV2(desc, drawSeed, relax);
}

/**
 * Compatibility adapter: a generation-1 linear chain as a graph mission.
 * Network, locks, answers and files are unchanged; two presentation fixes
 * apply (F04): the cipher offset gets a readable tag on the approach node, and
 * the plaque no longer prints the answer in plaintext.
 */
export function adaptLegacySpec(
  legacy: LegacySpecV1,
  descriptor: MissionDescriptor,
  draw: { seed: string; relax: number }
): MissionSpec {
  const nodes = legacy.nodes.map((n, i) => ({ ...n, root: n.root, route: null, pos: { row: i, col: 1 } }));
  nodes.forEach((n, i) => {
    const ans = legacy.puzzleAnswers[n.id];
    if (!ans || ans.family !== 'cipher' || i === 0) return;
    redactLegacyPlaque(n.root);
    const prev = nodes[i - 1]!;
    let srv = prev.root.dirs?.find((d) => d.name === 'srv');
    if (!srv) {
      srv = { name: 'srv', files: [], dirs: [] };
      prev.root.dirs = [...(prev.root.dirs ?? []), srv];
    }
    srv.files.push({
      name: `wheel_${n.hostname.toLowerCase()}.txt`,
      tag: 'plain',
      content: wheelClue(n.hostname, ans.shift),
      clueFor: n.id,
    });
  });
  return {
    descriptor: { ...descriptor },
    draw,
    kind: 'contract',
    index: legacy.index,
    seed: legacy.seed,
    name: legacy.name,
    codename: legacy.codename,
    brief: legacy.brief,
    handlerLines: legacy.handlerLines,
    debrief: 'Paid. The old wire still works.',
    nodes,
    edges: chainEdges(nodes),
    objective: { type: 'flagged', required: legacy.requiredTargets, targetIds: [...legacy.targetIds] },
    modifier: null,
    targetIds: legacy.targetIds,
    requiredTargets: legacy.requiredTargets,
    puzzleAnswers: legacy.puzzleAnswers,
  };
}

/** Back-compat: contract `index` from `seed` (campaign when it is that contract's seed). */
export function generateMission(index: number, seed: string, relax = 0): MissionSpec {
  const desc = seed === contractSeed(index) ? campaignDescriptor(index) : customDescriptor(seed, index);
  return generateFor(desc, seed, relax);
}

export function contractCount(): number {
  return CONFIG.mission.count;
}

export { contractSeed, Vfs };
