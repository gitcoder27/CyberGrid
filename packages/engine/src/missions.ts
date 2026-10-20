import { CONFIG } from './config.js';
import { Rng } from './rng.js';
import { generateKnock, generateSequence } from './puzzles.js';
import type {
  DirSpec,
  FileSpec,
  FileTag,
  MissionSpec,
  PuzzleAnswer,
  PuzzleFamily,
  MissionNodeSpec,
} from './types.js';
import { Vfs } from './vfs.js';

/**
 * Seeded procedural mission generation (PRD §15, MVP slice):
 * linear chain topology, 10 contracts scaling security/loot, objective "steal N files".
 * The generator is pure: same seed → byte-identical MissionSpec.
 *
 * Solvability is validated separately (validate.ts) by simulating a perfect run
 * through the real engine; the generator only draws, the validator decides.
 */

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

/** The Broker's dry, complicit, occasionally ominous mission framing (PRD §12). */
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
  '', // index 0 unused
  'Silent Ledger', 'Cold Boot', 'Paper Trail', 'Night Shift', 'Glass Jaw',
  'Hollow Point', 'Static Bloom', 'Dead Drop', 'Blackout Sale', 'The Long Exit',
];

function briefFor(required: number): string {
  return (
    `Infiltrate the chain, steal ${required} flagged files, and disconnect before the ` +
    `trace closes. Deeper nodes pay better and burn more trace. Logs buy margin.`
  );
}

interface IpAlloc {
  next: () => string;
}

function ipAllocator(rng: Rng): IpAlloc {
  const a = rng.int(10, 199);
  const b = rng.int(0, 254);
  let c = rng.int(1, 254);
  return {
    next: () => `10.${a}.${b}.${c++ % 254}`,
  };
}

function securityProfile(index: number, rng: Rng, relax = 0): (1 | 2 | 3)[] {
  const count = Math.max(
    2,
    CONFIG.mission.nodesByIndex[Math.min(index, CONFIG.mission.nodesByIndex.length - 1)]! - relax
  );
  const maxSec = Math.max(
    1,
    CONFIG.mission.maxSecurityByIndex[Math.min(index, CONFIG.mission.maxSecurityByIndex.length - 1)]! - relax
  );
  const secs: (1 | 2 | 3)[] = [];
  for (let i = 0; i < count; i++) {
    // Deeper in the chain = potentially harder; clamp to contract ceiling.
    const depthBonus = i >= count - 1 && index >= 4 ? 1 : 0;
    const base = Math.min(maxSec, 1 + Math.floor((i / Math.max(1, count - 1)) * (maxSec - 1)) + depthBonus);
    const jitter = rng.chance(0.25) ? (base < maxSec ? 1 : 0) : 0;
    secs.push(Math.max(1, Math.min(3, base + jitter)) as 1 | 2 | 3);
  }
  // Chains must be non-decreasing in places, but a small dip keeps variety; keep sorted
  // non-decreasing so "deeper is hotter" holds (PRD §3.1 decision layer).
  secs.sort((x, y) => x - y);
  return secs;
}

function puzzleFamilyFor(index: number, security: 1 | 2 | 3, rng: Rng): PuzzleFamily {
  if (index < CONFIG.mission.cipherFromIndex) {
    // Port-knock debuts on mission 1 (PRD §8): give sec-1 nodes a knock chance.
    if (security === 1) return rng.chance(index === 1 ? 0.35 : 0.5) ? 'portknock' : 'sequence';
    return rng.chance(0.5) ? 'portknock' : 'sequence';
  }
  if (security === 3) return rng.chance(0.6) ? 'cipher' : 'portknock';
  if (security === 2) return rng.pick(['portknock', 'cipher', 'cipher', 'sequence'] as const);
  return rng.chance(0.6) ? 'sequence' : 'portknock';
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
    value: CONFIG.economy.cashPerFileBySecurity[security]!,
    targetId: t.id,
  }));
  // Optional greed: one extra unflagged loot file roughly half the time.
  if (rng.chance(0.5)) {
    const extra = rng.pick(LOOT_NAMES.filter((n) => !targetFiles.some((t) => t.name === n)));
    lootFiles.push({ name: extra, tag: 'loot', value: Math.round(CONFIG.economy.cashPerFileBySecurity[security]! * 0.6) });
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
  if (cipherPlaque) {
    plain.push({ name: 'plaque.txt', tag: 'plain', content: cipherPlaque });
  }
  // Decide where the loot lives before wiring the tree so files are never duplicated.
  const inVault = rng.chance(0.5);
  const root = Vfs.specRoot('', [
    { name: 'srv', files: inVault ? [...plain] : [...lootFiles, ...plain], dirs: [] },
    { name: 'vault', files: inVault ? lootFiles : [], dirs: [] },
  ]);
  // Logs always live in /var/log (the `rm /var/log/...` fiction).
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

/**
 * Generate one contract. Deterministic in (index, seed, relax). This function does
 * NOT self-validate; see validate.ts for the perfect-run gate. `relax` (used only
 * by the validator's fallback pass) lowers the difficulty ceiling.
 */
export function generateMission(index: number, seed: string, relax = 0): MissionSpec {
  const rng = new Rng(`${seed}#${index}`);
  const ip = ipAllocator(rng);
  const names = rng.shuffle(NODE_NAMES);
  const secs = securityProfile(index, rng, relax);
  const required = CONFIG.mission.targetsByIndex[Math.min(index, CONFIG.mission.targetsByIndex.length - 1)]!;
  const codename = CODENAMES[Math.min(index, CODENAMES.length - 1)]!;

  // --- entry node (foothold: security 0, no loot, always one log to teach rm) ---
  const entry: MissionNodeSpec = {
    id: 'n0',
    ip: ip.next(),
    hostname: names[0]!,
    security: 0,
    puzzleFamily: 'sequence',
    root: buildNodeFiles(rng, 0, [], true, null).root,
  };
  entry.root = withHostname(entry.root, entry.hostname);

  // --- loot nodes ---
  let targetCounter = 0;
  const targetIds: string[] = [];
  const puzzleAnswers: Record<string, PuzzleAnswer> = {};
  const nodes: MissionNodeSpec[] = [entry];

  for (let i = 0; i < secs.length; i++) {
    const security = secs[i]!;
    const nodeId = `n${i + 1}`;
    const family = puzzleFamilyFor(index, security, rng);

    let answer: PuzzleAnswer;
    if (family === 'sequence') {
      const seq = generateSequence(rng, security);
      answer = { family: 'sequence', terms: seq.terms, answer: seq.answer, rule: seq.rule };
    } else if (family === 'portknock') {
      const tier = Math.min(
        CONFIG.puzzle.knockLengthByTier.length - 1,
        security - 1 + Math.floor(index / 4)
      );
      answer = { family: 'portknock', ports: generateKnock(rng, tier) };
    } else {
      const word = generateCipherWord(rng, security);
      answer = { family: 'cipher', word, shift: rng.int(1, 25) };
    }
    puzzleAnswers[nodeId] = answer;

    // Targets spread across the chain, at least `required` total.
    const targetsHere: { id: string; name: string }[] = [];
    const wantsTarget = targetCounter < required && (i % 2 === 1 || secs.length - i <= required - targetCounter);
    if (wantsTarget) {
      targetCounter++;
      const id = `target-${targetCounter}`;
      const name = rng.pick(LOOT_NAMES.filter((n) => n !== 'readme.txt'));
      targetsHere.push({ id, name });
      targetIds.push(id);
    }

    const cipherPlaque =
      answer.family === 'cipher'
        ? plaqueFor((answer as { word: string }).word, (answer as { shift: number }).shift)
        : null;

    const withLog = rng.chance(0.65);
    const node: MissionNodeSpec = {
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

  // Guarantee the objective is satisfiable even if the spread logic fell short.
  while (targetCounter < required) {
    targetCounter++;
    const id = `target-${targetCounter}`;
    const node = nodes[nodes.length - 1]!;
    const name = rng.pick(LOOT_NAMES.filter((n) => n !== 'readme.txt'));
    node.root.dirs![0]!.files.push({
      name,
      tag: 'target',
      value: CONFIG.economy.cashPerFileBySecurity[node.security]!,
      targetId: id,
    });
    targetIds.push(id);
  }

  const spec: MissionSpec = {
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
  return spec;
}

const CIPHER_WORDS_TIERS: string[][] = [
  ['GHOST', 'CIPHER', 'ORACLE', 'VIPER', 'SIREN', 'BLADE', 'RAVEN'],
  ['FIREWALL', 'BLACKICE', 'PAYLOAD', 'UPLINK', 'TERMINAL', 'OVERSEER'],
  ['INTRUSION', 'BACKDOOR', 'NIGHTFALL', 'COUNTERSPY', 'DARKNET', 'KEYSTONE'],
];

function generateCipherWord(rng: Rng, security: 1 | 2 | 3): string {
  const tier = Math.min(2, security - 1);
  return rng.pick(CIPHER_WORDS_TIERS[tier]!);
}

function withHostname(root: DirSpec, hostname: string): DirSpec {
  const readme = root.files.find((f) => f.name === 'readme.txt');
  if (readme && readme.content) {
    readme.content = readme.content.replace('internal node', `${hostname.toLowerCase()} — internal node`);
  }
  return root;
}

/** Fixed per-contract seed (same for every player — the future daily hook). */
export function contractSeed(index: number): string {
  return `CG-${CONFIG.season}-${String(index).padStart(2, '0')}`;
}

export function contractCount(): number {
  return CONFIG.mission.count;
}
