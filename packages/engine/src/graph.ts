import type { MissionNodeSpec, MissionSpec } from './types.js';

/**
 * Network graph helpers. Every system that asks "what links to what" —
 * breach adjacency, scan, watchdog patrols, decoys, autocomplete, the map,
 * validation — goes through these, so they can never disagree.
 */

export type Graph = Map<string, string[]>;

const graphCache = new WeakMap<MissionSpec, Graph>();

export function graphOf(spec: MissionSpec): Graph {
  let g = graphCache.get(spec);
  if (g) return g;
  g = new Map();
  for (const n of spec.nodes) g.set(n.id, []);
  for (const [a, b] of spec.edges) {
    if (!g.has(a) || !g.has(b) || a === b) continue;
    if (!g.get(a)!.includes(b)) g.get(a)!.push(b);
    if (!g.get(b)!.includes(a)) g.get(b)!.push(a);
  }
  graphCache.set(spec, g);
  return g;
}

export function neighbors(spec: MissionSpec, id: string): string[] {
  return graphOf(spec).get(id) ?? [];
}

export function linked(spec: MissionSpec, a: string, b: string): boolean {
  return neighbors(spec, a).includes(b);
}

export function nodeById(spec: MissionSpec, id: string): MissionNodeSpec | undefined {
  return spec.nodes.find((n) => n.id === id);
}

/** Hop distances from `from` (BFS). Unreachable nodes are absent. */
export function distances(spec: MissionSpec, from: string): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of neighbors(spec, cur)) {
      if (!dist.has(nb)) {
        dist.set(nb, dist.get(cur)! + 1);
        queue.push(nb);
      }
    }
  }
  return dist;
}

/** Shortest path (inclusive) from `from` to `to`, preferring `allowed` nodes. */
export function shortestPath(
  spec: MissionSpec,
  from: string,
  to: string,
  allowed: (id: string) => boolean = () => true
): string[] | null {
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const nb of neighbors(spec, cur)) {
      if (prev.has(nb) || (!allowed(nb) && nb !== to)) continue;
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  if (!prev.has(to)) return null;
  const path: string[] = [];
  for (let at: string | null = to; at !== null; at = prev.get(at) ?? null) path.unshift(at);
  return path;
}

/** Locked nodes linked to any node in `owned` (the breach frontier). */
export function frontier(spec: MissionSpec, owned: Set<string>): string[] {
  const out: string[] = [];
  for (const n of spec.nodes) {
    if (owned.has(n.id)) continue;
    if (neighbors(spec, n.id).some((nb) => owned.has(nb))) out.push(n.id);
  }
  return out;
}

/** Map layout: explicit generator positions, else BFS depth in a single lane. */
export function layoutOf(spec: MissionSpec): Map<string, { depth: number; lane: number }> {
  const out = new Map<string, { depth: number; lane: number }>();
  const dist = distances(spec, spec.nodes[0]!.id);
  for (const n of spec.nodes) {
    out.set(n.id, n.pos ? { depth: n.pos.row, lane: n.pos.col } : { depth: dist.get(n.id) ?? 0, lane: 1 });
  }
  return out;
}

/** Chain edges for a node list (legacy adapter and chain topology). */
export function chainEdges(nodes: { id: string }[]): [string, string][] {
  const edges: [string, string][] = [];
  for (let i = 1; i < nodes.length; i++) edges.push([nodes[i - 1]!.id, nodes[i]!.id]);
  return edges;
}
