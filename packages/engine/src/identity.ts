import { CONFIG } from './config.js';
import { Rng } from './rng.js';
import type { MissionDescriptor, MissionMode, ModifierId, ObjectiveType, Topology } from './types.js';

/**
 * Mission identity (F06). A descriptor is the complete generation input; a
 * share code is its exact, versioned, checksummed text form. Decorative labels
 * (the banner's `CGOM-EN01` style) are never parsed back.
 *
 *   CG1-2C04FF0-INDS2T2NIVHC2MBU-K3QF
 *   │   │││ │││ │                 └ checksum (4 base32 chars)
 *   │   │││ │││ └ seed: base32 of its UTF-8 bytes (case/Unicode exact)
 *   │   │││ ││└ modifier: 0 none · N noisy link · P active patrol
 *   │   │││ │└ objective: F flagged files · D dossier · U payload upload
 *   │   │││ └ topology: L linear chain · F fork-and-rejoin
 *   │   ││└ tier 01..10
 *   │   │└ mode: C campaign · X custom · D daily
 *   │   └ generation/rules version (1 legacy chain, 2 graph)
 *   └ share-code format version
 */

export const SHARE_FORMAT = 'CG1';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array | null {
  const clean = text.toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fromUtf8(b: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

function checksum(body: string): string {
  const h = Rng.hashSeed(`cg-share:${body}`);
  let out = '';
  for (let i = 0; i < 4; i++) out += B32[(h >>> (i * 5)) & 31];
  return out;
}

const MODE_CODE: Record<Exclude<MissionMode, 'tutorial'>, string> = { campaign: 'C', custom: 'X', daily: 'D' };
const TOPO_CODE: Record<Topology, string> = { chain: 'L', fork: 'F' };
const OBJ_CODE: Record<ObjectiveType, string> = { flagged: 'F', dossier: 'D', payload: 'U' };
const MOD_CODE: Record<string, string> = { none: '0', noisy: 'N', patrol: 'P' };

const invert = <T extends string>(m: Record<T, string>): Record<string, T> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<string, T>;

/** Characters (code points) a custom seed may carry. */
export const MAX_SEED_LENGTH = 96;

export function encodeShareCode(d: MissionDescriptor): string {
  if (d.mode === 'tutorial') return '';
  const head =
    `${d.gen}${MODE_CODE[d.mode]}${String(d.tier).padStart(2, '0')}` +
    `${TOPO_CODE[d.topology]}${OBJ_CODE[d.objective]}${MOD_CODE[d.modifier ?? 'none']}`;
  const body = `${SHARE_FORMAT}-${head}-${base32Encode(utf8(d.seed))}`;
  return `${body}-${checksum(body)}`;
}

export type DecodeResult =
  | { ok: true; descriptor: MissionDescriptor }
  | { ok: false; reason: 'malformed' | 'checksum' | 'unsupported-format' | 'unsupported-gen' | 'invalid'; message: string };

/** Parse a share code. Case-insensitive; whitespace tolerated. Never throws. */
export function decodeShareCode(raw: string): DecodeResult {
  const text = raw.trim().replace(/\s+/g, '').toUpperCase();
  const parts = text.split('-');
  if (parts.length !== 4 || !/^CG\d+$/.test(parts[0]!)) {
    return { ok: false, reason: 'malformed', message: 'not a share code — they look like CG1-2C04FF0-…-XXXX.' };
  }
  const [fmt, head, seed32, chk] = parts as [string, string, string, string];
  if (fmt !== SHARE_FORMAT) {
    return { ok: false, reason: 'unsupported-format', message: `share format ${fmt} is newer than this terminal understands.` };
  }
  if (checksum(`${fmt}-${head}-${seed32}`) !== chk) {
    return { ok: false, reason: 'checksum', message: 'checksum mismatch — a character got mangled in transit.' };
  }
  const m = /^(\d)([A-Z])(\d\d)([A-Z])([A-Z])([0-9A-Z])$/.exec(head);
  if (!m) return { ok: false, reason: 'malformed', message: 'the job header is garbled.' };
  const gen = Number(m[1]);
  if (gen !== 1 && gen !== 2) {
    return { ok: false, reason: 'unsupported-gen', message: `generation ${gen} jobs need a newer terminal.` };
  }
  const mode = invert(MODE_CODE)[m[2]!];
  const tier = Number(m[3]);
  const topology = invert(TOPO_CODE)[m[4]!];
  const objective = invert(OBJ_CODE)[m[5]!];
  const modKey = invert(MOD_CODE)[m[6]!];
  const bytes = base32Decode(seed32);
  const seed = bytes ? fromUtf8(bytes) : null;
  if (!mode || !topology || !objective || !modKey || seed === null || !seed || tier < 1 || tier > CONFIG.mission.count) {
    return { ok: false, reason: 'invalid', message: 'the code decodes, but describes no job this terminal can build.' };
  }
  const descriptor: MissionDescriptor = {
    gen: gen as 1 | 2,
    mode,
    seed,
    tier,
    topology,
    objective,
    modifier: modKey === 'none' ? null : (modKey as ModifierId),
  };
  const problem = descriptorProblem(descriptor);
  if (problem) return { ok: false, reason: 'invalid', message: problem };
  return { ok: true, descriptor };
}

/** Structural sanity for descriptors from outside (codes, saves). */
export function descriptorProblem(d: MissionDescriptor): string | null {
  if (d.mode === 'tutorial') return null;
  if (!Number.isInteger(d.tier) || d.tier < 1 || d.tier > CONFIG.mission.count) return 'tier out of range.';
  if (typeof d.seed !== 'string' || !d.seed.trim() || [...d.seed].length > MAX_SEED_LENGTH) return 'bad seed.';
  if (d.gen === 1 && (d.topology !== 'chain' || d.objective !== 'flagged' || d.modifier !== null)) {
    return 'generation-1 jobs are linear flagged-file chains only.';
  }
  return null;
}

/* ------------------------------ constructors ------------------------------ */

export function contractSeed(index: number): string {
  return `CG-${CONFIG.season}-${String(index).padStart(2, '0')}`;
}

export function campaignDescriptor(index: number): MissionDescriptor {
  const plan = CONFIG.campaign[Math.max(0, Math.min(CONFIG.campaign.length - 1, index - 1))]!;
  return {
    gen: CONFIG.currentGen,
    mode: 'campaign',
    seed: contractSeed(index),
    tier: index,
    topology: plan.topology,
    objective: plan.objective,
    modifier: plan.modifier,
  };
}

/** Deterministic layout pick for custom/daily seeds: identity, not progress. */
export function planFor(seed: string, tier: number): Pick<MissionDescriptor, 'topology' | 'objective' | 'modifier'> {
  const g = CONFIG.generation.v2;
  if (tier <= 3) return { topology: 'chain', objective: 'flagged', modifier: null };
  const rng = new Rng(`plan:${seed}#${tier}`);
  const topology: Topology = rng.chance(g.forkChance) ? 'fork' : 'chain';
  const weights = g.objectiveWeights;
  const total = weights.flagged + weights.dossier + weights.payload;
  let roll = rng.next() * total;
  let objective: ObjectiveType = 'flagged';
  for (const k of ['flagged', 'dossier', 'payload'] as const) {
    roll -= weights[k];
    if (roll < 0) {
      objective = k;
      break;
    }
  }
  let modifier: ModifierId | null = null;
  if (tier >= g.modifierFromTier && rng.chance(g.modifierChance)) {
    modifier = rng.chance(0.5) ? 'noisy' : 'patrol';
  }
  return { topology, objective, modifier };
}

export function customDescriptor(seed: string, tier: number = CONFIG.modes.customDefaultTier): MissionDescriptor {
  return { gen: CONFIG.currentGen, mode: 'custom', seed, tier, ...planFor(seed, tier) };
}

export function tutorialDescriptor(): MissionDescriptor {
  return {
    gen: CONFIG.currentGen,
    mode: 'tutorial',
    seed: CONFIG.tutorial.seed,
    tier: 0,
    topology: 'chain',
    objective: 'flagged',
    modifier: null,
  };
}

/* --------------------------------- daily --------------------------------- */

/** `YYYY-MM-DD` of an instant in UTC — never the player's local timezone. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dailyDescriptor(date: string): MissionDescriptor {
  const seed = `DAILY-${date}`;
  const tier = CONFIG.daily.tier;
  return { gen: CONFIG.currentGen, mode: 'daily', seed, tier, ...planFor(seed, tier) };
}

export function dailyDateOf(d: MissionDescriptor): string | null {
  if (d.mode !== 'daily') return null;
  const m = /^DAILY-(\d{4}-\d{2}-\d{2})$/.exec(d.seed);
  return m ? m[1]! : null;
}

/* ------------------------------ presentation ------------------------------ */

/** Stable cache key for a descriptor (also the records identity prefix). */
export function descriptorKey(d: MissionDescriptor): string {
  return [d.gen, d.mode, d.tier, d.topology, d.objective, d.modifier ?? '-', d.seed].join('|');
}

export function describeDescriptor(d: MissionDescriptor): string {
  if (d.mode === 'tutorial') return 'warm-up';
  const mode = d.mode === 'campaign' ? `contract #${d.tier}` : d.mode === 'daily' ? `daily ${dailyDateOf(d) ?? ''}`.trim() : `custom tier ${d.tier}`;
  const topo = d.topology === 'fork' ? 'forked network' : 'linear chain';
  const obj = d.objective === 'flagged' ? 'flagged files' : d.objective === 'dossier' ? 'dossier' : 'payload drop';
  const mod = d.modifier ? ` · ${CONFIG.modifiers[d.modifier].name.toLowerCase()}` : '';
  return `${mode} · ${topo} · ${obj}${mod}${d.gen === 1 ? ' · legacy gen 1' : ''}`;
}
