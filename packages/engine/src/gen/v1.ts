import { Rng } from '../rng.js';
import type { DirSpec, FileSpec, FileTag, PuzzleAnswer, PuzzleFamily } from '../types.js';

/**
 * GENERATION VERSION 1 — FROZEN.
 *
 * This is the original linear-chain generator, kept byte-for-byte equivalent so
 * that recoverable legacy sessions (saved before mission identities existed) and
 * generation-1 share codes regenerate exactly the network that was played.
 * Every constant it reads is pinned below instead of coming from CONFIG: tuning
 * the live game must never rewrite a legacy job. `test/legacy.test.ts` checks
 * the output against fingerprints captured from the pre-migration code.
 *
 * Do not edit. New generation work belongs in gen/v2.ts.
 */

const V1 = {
  season: 'OMEN',
  nodesByIndex: [0, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6],
  targetsByIndex: [0, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4],
  maxSecurityByIndex: [0, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3],
  cipherFromIndex: 4,
  cashPerFileBySecurity: [40, 90, 160, 260],
  knockLengthByTier: [4, 4, 5, 5, 6, 7],
  knockPortPool: [22, 53, 80, 143, 443, 587, 1521, 3306, 3389, 8080, 8443, 9090],
} as const;

/** The legacy spec shape, field order included (fingerprints hash the JSON). */
export interface LegacySpecV1 {
  kind: 'contract' | 'tutorial';
  index: number;
  seed: string;
  name: string;
  codename: string;
  brief: string;
  handlerLines: string[];
  nodes: {
    id: string;
    ip: string;
    hostname: string;
    security: 0 | 1 | 2 | 3;
    puzzleFamily: PuzzleFamily;
    root: DirSpec;
  }[];
  targetIds: string[];
  requiredTargets: number;
  puzzleAnswers: Record<string, PuzzleAnswer>;
}

const NODE_NAMES = [
  'GATEKEEPER', 'LEDGERPRIME', 'VAULTLINE', 'HELIOS', 'CINDERBLOCK', 'NULLWEAVE',
  'IRONHALO', 'PALEHORSE', 'STATICBARN', 'LOWTIDE', 'GLASSHOUSE', 'DARKHARBOR',
  'PAPERCLIP', 'QUICKSAND', 'RUSTBUCKET', 'MIDNIGHTSUN', 'COLDSTORAGE', 'FLICKER',
];

const LOOT_NAMES = [
  'ledger.dat', 'payroll.db', 'vault_keys.enc', 'contracts.tar', 'blueprints.enc',
  'client_list.csv', 'encryption_keys.asc', 'biospecs.zip', 'shipping_manifest.xlsx',
  'shadow_books.db', 'wirelog.dat', 'schema_backup.sql',
];

const PLAIN_LORE: string[] = [
  'memo: if you are reading this from outside the building, please stop.\n management',
  'email thread "RE: RE: RE: badge access" — 41 replies, all "++".\nthe grid trust thanks you for your compliance.',
  'note taped under keyboard: password is on the plaque. the PLAQUE. — R.',
  'shift log: 03:14 watchdog barked at a moth again. marked as intrusion. HR notified.',
  'cafeteria review: the noodles have achieved sentience. one star.',
  'IT ticket #8812: "keyboard only types in caps, feels ominous" — closed as wontfix.',
  'memo: rotating the cipher wheel offsets weekly. this week: see facilities plaque.',
  'all-hands: the lights that pulse red are DECORATIVE. do not evacuate.',
];

function handlerLines(index: number, codename: string, required: number): string[] {
  const openers = [
    `Contract ${index}. "${codename}". Small shop, fat ledger.`,
    `"${codename}" just cleared escrow. Try to look professional.`,
    `New key for "${codename}". The owner has insurance; you have speed.`,
    `"${codename}". They moved the ledger again. You know the drill.`,
    `Broker says "${codename}" is quiet this week. Broker lies, but not always.`,
  ];
  const tails = [
    `Pull ${required} files. Keep the trace cold. Disconnect before it gets loud.`,
    `${required} files, in and out. If the meter climbs, buy it down — logs are your friend.`,
    `I need ${required} files and zero drama. Drama bills at half.`,
    `Steal ${required}. Wipe what you touch. And operator — watch the meter.`,
    `${required} files. If it goes sideways, a proxy hop beats a eulogy.`,
  ];
  return [openers[index % openers.length]!, tails[index % tails.length]!];
}

const CODENAMES = [
  '',
  'Silent Ledger', 'Cold Boot', 'Paper Trail', 'Night Shift', 'Glass Jaw',
  'Hollow Point', 'Static Bloom', 'Dead Drop', 'Blackout Sale', 'The Long Exit',
];

function briefFor(required: number): string {
  return (
    `Infiltrate the chain, steal ${required} flagged files, and disconnect before the ` +
    `trace closes. Deeper nodes pay better and burn more trace. Logs buy margin.`
  );
}

function ipAllocator(rng: Rng): { next: () => string } {
  const a = rng.int(10, 199);
  const b = rng.int(0, 254);
  let c = rng.int(1, 254);
  return { next: () => `10.${a}.${b}.${c++ % 254}` };
}

function securityProfile(index: number, rng: Rng, relax = 0): (1 | 2 | 3)[] {
  const count = Math.max(2, V1.nodesByIndex[Math.min(index, V1.nodesByIndex.length - 1)]! - relax);
  const maxSec = Math.max(1, V1.maxSecurityByIndex[Math.min(index, V1.maxSecurityByIndex.length - 1)]! - relax);
  const secs: (1 | 2 | 3)[] = [];
  for (let i = 0; i < count; i++) {
    const depthBonus = i >= count - 1 && index >= 4 ? 1 : 0;
    const base = Math.min(maxSec, 1 + Math.floor((i / Math.max(1, count - 1)) * (maxSec - 1)) + depthBonus);
    const jitter = rng.chance(0.25) ? (base < maxSec ? 1 : 0) : 0;
    secs.push(Math.max(1, Math.min(3, base + jitter)) as 1 | 2 | 3);
  }
  secs.sort((x, y) => x - y);
  return secs;
}

function puzzleFamilyFor(index: number, security: 1 | 2 | 3, rng: Rng): PuzzleFamily {
  if (index < V1.cipherFromIndex) {
    if (security === 1) return rng.chance(index === 1 ? 0.35 : 0.5) ? 'portknock' : 'sequence';
    return rng.chance(0.5) ? 'portknock' : 'sequence';
  }
  if (security === 3) return rng.chance(0.6) ? 'cipher' : 'portknock';
  if (security === 2) return rng.pick(['portknock', 'cipher', 'cipher', 'sequence'] as const);
  return rng.chance(0.6) ? 'sequence' : 'portknock';
}

function specRootV1(hostname: string, dirs: DirSpec[]): DirSpec {
  return {
    name: '/',
    files: [
      {
        name: 'readme.txt',
        tag: 'plain',
        content:
          `${hostname} — internal node. Unauthorized access is monitored.\n` +
          `Segments of this node are the property of the grid trust. You agree to this\n` +
          `by reading this file.`,
      },
    ],
    dirs: [
      ...dirs,
      { name: 'home', files: [], dirs: [{ name: 'operator', files: [], dirs: [] }] },
      { name: 'var', files: [], dirs: [{ name: 'log', files: [] }] },
    ],
  };
}

function buildNodeFiles(
  rng: Rng,
  security: 0 | 1 | 2 | 3,
  targetFiles: { id: string; name: string }[],
  withLog: boolean,
  cipherPlaque: string | null
): { root: DirSpec } {
  const lootFiles: FileSpec[] = targetFiles.map((t) => ({
    name: t.name,
    tag: 'target' as FileTag,
    value: V1.cashPerFileBySecurity[security]!,
    targetId: t.id,
  }));
  if (rng.chance(0.5)) {
    const extra = rng.pick(LOOT_NAMES.filter((n) => !targetFiles.some((t) => t.name === n)));
    lootFiles.push({ name: extra, tag: 'loot', value: Math.round(V1.cashPerFileBySecurity[security]! * 0.6) });
  }
  const logs: FileSpec[] = withLog
    ? [
        {
          name: rng.pick(['auth.log', 'access.log', 'tracepipe.log']),
          tag: 'log',
          content: 'session records. foreign handshake signatures present.',
        },
      ]
    : [];
  const plain: FileSpec[] = [
    {
      name: rng.pick(['memo.txt', 'notes.md', 'tickets.txt', 'shift.log']),
      tag: 'plain',
      content: rng.pick(PLAIN_LORE),
    },
  ];
  if (cipherPlaque) plain.push({ name: 'plaque.txt', tag: 'plain', content: cipherPlaque });
  const inVault = rng.chance(0.5);
  const root = specRootV1('', [
    { name: 'srv', files: inVault ? [...plain] : [...lootFiles, ...plain], dirs: [] },
    { name: 'vault', files: inVault ? lootFiles : [], dirs: [] },
  ]);
  const varDir = root.dirs!.find((d) => d.name === 'var')!;
  const logDir = varDir.dirs!.find((d) => d.name === 'log')!;
  logDir.files = logs;
  return { root };
}

function plaqueFor(word: string, shift: number): string {
  return (
    `FACILITIES PLAQUE — cipher wheel service tag\n` +
    `wheel offset: ${shift}\n` +
    `master lockword: ${word}\n` +
    `(facilities keeps losing the wheel. do not remove from break room.)`
  );
}

const SEQUENCE_NEXT: Record<string, (t: number[]) => number> = {
  arith: (t) => t[t.length - 1]! + (t[1]! - t[0]!),
  geo: (t) => Math.round(t[t.length - 1]! * (t[1]! / t[0]!)),
  fib: (t) => t[t.length - 1]! + t[t.length - 2]!,
  square: (t) => {
    const n = Math.round(Math.sqrt(t[t.length - 1]!));
    return (n + 1) * (n + 1);
  },
};
const SEQUENCE_RULE_TEXT: Record<string, string> = {
  arith: 'constant step',
  geo: 'constant ratio',
  fib: 'each term is the sum of the previous two',
  square: 'perfect squares',
};

function generateSequenceV1(rng: Rng, security: 1 | 2 | 3): { terms: number[]; answer: number; rule: string } {
  const pool: string[] =
    security === 1 ? ['arith', 'geo'] : security === 2 ? ['geo', 'fib', 'square'] : ['fib', 'square', 'geo'];
  const key = rng.pick(pool);
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
  return { terms, answer: SEQUENCE_NEXT[key]!(terms), rule: SEQUENCE_RULE_TEXT[key]! };
}

function generateKnockV1(rng: Rng, tier: number): number[] {
  const clampedTier = Math.max(0, Math.min(V1.knockLengthByTier.length - 1, tier));
  const len = V1.knockLengthByTier[clampedTier]!;
  const ports: number[] = [];
  while (ports.length < len) {
    const p = rng.pick(V1.knockPortPool);
    if (!ports.includes(p)) ports.push(p);
  }
  return ports;
}

const CIPHER_WORDS_TIERS: string[][] = [
  ['GHOST', 'CIPHER', 'ORACLE', 'VIPER', 'SIREN', 'BLADE', 'RAVEN'],
  ['FIREWALL', 'BLACKICE', 'PAYLOAD', 'UPLINK', 'TERMINAL', 'OVERSEER'],
  ['INTRUSION', 'BACKDOOR', 'NIGHTFALL', 'COUNTERSPY', 'DARKNET', 'KEYSTONE'],
];

function withHostname(root: DirSpec, hostname: string): DirSpec {
  const readme = root.files.find((f) => f.name === 'readme.txt');
  if (readme && readme.content) {
    readme.content = readme.content.replace('internal node', `${hostname.toLowerCase()} — internal node`);
  }
  return root;
}

/** Generate one generation-1 contract. Deterministic in (index, seed, relax). */
export function generateMissionV1(index: number, seed: string, relax = 0): LegacySpecV1 {
  const rng = new Rng(`${seed}#${index}`);
  const ip = ipAllocator(rng);
  const names = rng.shuffle(NODE_NAMES);
  const secs = securityProfile(index, rng, relax);
  const required = V1.targetsByIndex[Math.min(index, V1.targetsByIndex.length - 1)]!;
  const codename = CODENAMES[Math.min(index, CODENAMES.length - 1)]!;

  const entry: LegacySpecV1['nodes'][number] = {
    id: 'n0',
    ip: ip.next(),
    hostname: names[0]!,
    security: 0,
    puzzleFamily: 'sequence',
    root: buildNodeFiles(rng, 0, [], true, null).root,
  };
  entry.root = withHostname(entry.root, entry.hostname);

  let targetCounter = 0;
  const targetIds: string[] = [];
  const puzzleAnswers: Record<string, PuzzleAnswer> = {};
  const nodes: LegacySpecV1['nodes'] = [entry];

  for (let i = 0; i < secs.length; i++) {
    const security = secs[i]!;
    const nodeId = `n${i + 1}`;
    const family = puzzleFamilyFor(index, security, rng);

    let answer: PuzzleAnswer;
    if (family === 'sequence') {
      const seq = generateSequenceV1(rng, security);
      answer = { family: 'sequence', terms: seq.terms, answer: seq.answer, rule: seq.rule };
    } else if (family === 'portknock') {
      const tier = Math.min(V1.knockLengthByTier.length - 1, security - 1 + Math.floor(index / 4));
      answer = { family: 'portknock', ports: generateKnockV1(rng, tier) };
    } else {
      const word = rng.pick(CIPHER_WORDS_TIERS[Math.min(2, security - 1)]!);
      answer = { family: 'cipher', word, shift: rng.int(1, 25) };
    }
    puzzleAnswers[nodeId] = answer;

    const targetsHere: { id: string; name: string }[] = [];
    const wantsTarget = targetCounter < required && (i % 2 === 1 || secs.length - i <= required - targetCounter);
    if (wantsTarget) {
      targetCounter++;
      const id = `target-${targetCounter}`;
      const name = rng.pick(LOOT_NAMES.filter((n) => n !== 'readme.txt'));
      targetsHere.push({ id, name });
      targetIds.push(id);
    }

    const cipherPlaque = answer.family === 'cipher' ? plaqueFor(answer.word, answer.shift) : null;
    const withLog = rng.chance(0.65);
    const node: LegacySpecV1['nodes'][number] = {
      id: nodeId,
      ip: ip.next(),
      hostname: names[i + 1]!,
      security,
      puzzleFamily: family,
      root: buildNodeFiles(rng, security, targetsHere, withLog, cipherPlaque).root,
    };
    node.root = withHostname(node.root, node.hostname);
    nodes.push(node);
  }

  while (targetCounter < required) {
    targetCounter++;
    const id = `target-${targetCounter}`;
    const node = nodes[nodes.length - 1]!;
    const name = rng.pick(LOOT_NAMES.filter((n) => n !== 'readme.txt'));
    node.root.dirs![0]!.files.push({
      name,
      tag: 'target',
      value: V1.cashPerFileBySecurity[node.security]!,
      targetId: id,
    });
    targetIds.push(id);
  }

  return {
    kind: 'contract',
    index,
    seed,
    name: `${codename}`,
    codename,
    brief: briefFor(required),
    handlerLines: handlerLines(index, codename, required),
    nodes,
    targetIds,
    requiredTargets: required,
    puzzleAnswers,
  };
}

/** Fixed generation-1 campaign seed. */
export function contractSeedV1(index: number): string {
  return `CG-${V1.season}-${String(index).padStart(2, '0')}`;
}

/**
 * Recover the generation input of a legacy validated draw. Generation-1
 * validation re-drew failing seeds as `<seed>~<n>` and relaxed ones as
 * `<seed>~x<relax>~<n|final>`; the session stored the drawn seed only.
 */
export function parseLegacyDraw(drawSeed: string): { original: string; relax: number } {
  const relaxed = /^(.*)~x(\d+)~(\d+|final)$/.exec(drawSeed);
  if (relaxed) return { original: relaxed[1]!, relax: Number(relaxed[2]) };
  const redraw = /^(.*)~(\d+)$/.exec(drawSeed);
  if (redraw) return { original: redraw[1]!, relax: 0 };
  return { original: drawSeed, relax: 0 };
}
