import { walkSpecFiles } from './vfs.js';
import type { MissionSpec, ObjectiveSpec } from './types.js';

/**
 * Data-driven objective evaluation (E02). The engine, HUD snapshot, scoring,
 * validator and simulator all ask these functions whether a job is done —
 * completion never depends on a hardcoded download count.
 */

export interface ObjectiveProgressState {
  downloadedTargets: ReadonlySet<string>;
  payloadPlaced: boolean;
}

export function objectiveDone(obj: ObjectiveSpec, st: ObjectiveProgressState): boolean {
  switch (obj.type) {
    case 'flagged':
      return obj.targetIds.filter((id) => st.downloadedTargets.has(id)).length >= obj.required;
    case 'dossier':
      return st.downloadedTargets.has(obj.targetId);
    case 'payload':
      return st.payloadPlaced;
  }
}

/** (have, need) for result summaries and the HUD. */
export function objectiveCount(obj: ObjectiveSpec, st: ObjectiveProgressState): { have: number; need: number } {
  switch (obj.type) {
    case 'flagged':
      return { have: Math.min(obj.required, obj.targetIds.filter((id) => st.downloadedTargets.has(id)).length), need: obj.required };
    case 'dossier':
      return { have: st.downloadedTargets.has(obj.targetId) ? 1 : 0, need: 1 };
    case 'payload':
      return { have: st.payloadPlaced ? 1 : 0, need: 1 };
  }
}

export function objectiveLabel(spec: MissionSpec): string {
  const obj = spec.objective;
  const host = (id: string) => spec.nodes.find((n) => n.id === id)?.hostname ?? id;
  switch (obj.type) {
    case 'flagged':
      return `steal ${obj.required} flagged file${obj.required === 1 ? '' : 's'}`;
    case 'dossier':
      return `extract ${obj.fileName} (${host(obj.nodeId)})`;
    case 'payload':
      return `upload ${obj.payloadName} → ${host(obj.nodeId)}:${obj.dir}`;
  }
}

export function objectiveProgressText(spec: MissionSpec, st: ObjectiveProgressState): string {
  const { have, need } = objectiveCount(spec.objective, st);
  switch (spec.objective.type) {
    case 'flagged':
      return `${have}/${need} flagged files`;
    case 'dossier':
      return have ? 'dossier secured' : 'dossier not yet pulled';
    case 'payload':
      return have ? 'payload planted' : 'payload on your rig';
  }
}

/** Does this node still hold something the objective needs? */
export function objectiveRoleOf(
  spec: MissionSpec,
  nodeId: string,
  st: ObjectiveProgressState
): 'target' | 'dossier' | 'drop' | null {
  const obj = spec.objective;
  if (obj.type === 'payload') return obj.nodeId === nodeId && !st.payloadPlaced ? 'drop' : null;
  if (obj.type === 'dossier') return obj.nodeId === nodeId && !st.downloadedTargets.has(obj.targetId) ? 'dossier' : null;
  const node = spec.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  if (objectiveDone(obj, st)) return null;
  const left = walkSpecFiles(node.root).some(
    (f) => f.tag === 'target' && f.targetId && obj.targetIds.includes(f.targetId) && !st.downloadedTargets.has(f.targetId)
  );
  return left ? 'target' : null;
}

/** Node ids the objective requires visiting (for validation and routing). */
export function objectiveNodeIds(spec: MissionSpec): string[] {
  const obj = spec.objective;
  if (obj.type !== 'flagged') return [obj.nodeId];
  const out: string[] = [];
  for (const n of spec.nodes) {
    if (walkSpecFiles(n.root).some((f) => f.tag === 'target' && f.targetId && obj.targetIds.includes(f.targetId))) out.push(n.id);
  }
  return out;
}
