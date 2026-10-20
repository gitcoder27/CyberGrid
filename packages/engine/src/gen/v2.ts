import { CONFIG } from '../config.js';
import { Rng } from '../rng.js';
import { generateKnock, generateSequence, caesar } from '../puzzles.js';
import { chainEdges } from '../graph.js';
import type {
  DirSpec,
  FileSpec,
  MissionDescriptor,
  MissionNodeSpec,
  MissionSpec,
  ObjectiveSpec,
  PuzzleAnswer,
  PuzzleFamily,
} from '../types.js';
import { Vfs } from '../vfs.js';

/**
 * GENERATION VERSION 2 — graph missions (E02/E06).
 *
 * Topologies:
 *   chain  n0 ─ n1 ─ n2 ─ …                      (introductory contracts)
 *   fork   n0 ─ a1 ─ a2 ─┐
 *           └── b1 ──────┴─ J ─ [K]               two approaches rejoin at J
 *                          └─ V                   optional vault
 * The long route has more, lower-security locks plus a log and some greed loot;
 * the hot route is one high-security lock with nothing to pick up. Objectives
 * (flagged files, a specific dossier, or a payload upload) sit at or past the
 * junction, so either approach can finish the job.
 *
 * Pure: same (descriptor, draw seed, relax) → byte-identical MissionSpec.
 * Validation (validate.ts) decides which draws ship.
 */

const G = CONFIG.generation.v2;

const NODE_NAMES = [
  'GATEKEEPER', 'LEDGERPRIME', 'VAULTLINE', 'HELIOS', 'CINDERBLOCK', 'NULLWEAVE',
  'IRONHALO', 'PALEHORSE', 'STATICBARN', 'LOWTIDE', 'GLASSHOUSE', 'DARKHARBOR',
  'PAPERCLIP', 'QUICKSAND', 'RUSTBUCKET', 'MIDNIGHTSUN', 'COLDSTORAGE', 'FLICKER',
  'SALTMARSH', 'BRASSNECK',
];

const LOOT_NAMES = [
  'ledger.dat', 'payroll.db', 'vault_keys.enc', 'contracts.tar', 'blueprints.enc',
  'client_list.csv', 'encryption_keys.asc', 'biospecs.zip', 'shipping_manifest.xlsx',
  'shadow_books.db', 'wirelog.dat', 'schema_backup.sql',
];

const VAULT_LOOT = ['bearer_bonds.pdf', 'cold_wallet.key', 'board_minutes.enc', 'black_budget.xlsx', 'master_keyring.asc'];

const PAYLOADS = ['ghostkey.so', 'implant.bin', 'tapeworm.ko', 'nightjar.elf'];

const SUBJECTS = ['halvorsen', 'okafor', 'voss', 'marchetti', 'ilyina', 'brandt', 'castellanos', 'nakamura', 'oduya', 'lindqvist'];

const PLAIN_LORE: string[] = [
  'memo: if you are reading this from outside the building, please stop.\n management',
  'email thread "RE: RE: RE: badge access" — 41 replies, all "++".\nthe grid trust thanks you for your compliance.',
  'shift log: 03:14 watchdog barked at a moth again. marked as intrusion. HR notified.',
  'cafeteria review: the noodles have achieved sentience. one star.',
  'IT ticket #8812: "keyboard only types in caps, feels ominous" — closed as wontfix.',
  'all-hands: the lights that pulse red are DECORATIVE. do not evacuate.',
  'post-it: the vault box hums when the backup job runs. nobody knows which backup job.',
  'audit note: "logs rotate nightly" — they do not. please stop writing that in reports.',
  'chat export: <dmitri> who keeps naming servers after weather <ana> the weather',
  'memo: facilities rotated the cipher wheels again. tags are posted next to each lock.',
];

const CUSTOM_ADJ = ['Velvet', 'Copper', 'Hollow', 'Paper', 'Static', 'Glass', 'Quiet', 'Iron', 'Neon', 'Ashen', 'Silver', 'Broken'];
const CUSTOM_NOUN = ['Wake', 'Ledger', 'Harbor', 'Signal', 'Mirror', 'Engine', 'Orchard', 'Lantern', 'Circuit', 'Tide', 'Vault', 'Choir'];

export const CAMPAIGN_CODENAMES = [
  '',
  'Silent Ledger', 'Cold Boot', 'Paper Trail', 'Night Shift', 'Glass Jaw',
  'Hollow Point', 'Static Bloom', 'Dead Drop', 'Blackout Sale', 'The Long Exit',
];

/** One-line Broker sign-offs per campaign contract (mission-specific debriefs). */
const CAMPAIGN_DEBRIEFS = [
  '',
  'Clean ledger, clean hands. Mostly.',
  'They rebooted cold and never knew why. Nice.',
  'Paper trail\'s ours now. Somebody upstairs is sweating.',
  'Two doors, one job, you picked. That\'s the whole trade.',
  'Got the file. Don\'t read it. ...You read it. Fine.',
  'Loud wire, quiet operator. That\'s worth the hazard pay.',
  'The implant\'s singing. We\'ll be listening for months.',
  'Their dog walked right past you. I owe you a drink.',
  'Second payload\'s live. Blackout\'s on schedule.',
  'That\'s the last one. Stay on the line a second.',
];

const CIPHER_WORDS_TIERS: string[][] = [
  ['GHOST', 'CIPHER', 'ORACLE', 'VIPER', 'SIREN', 'BLADE', 'RAVEN'],
  ['FIREWALL', 'BLACKICE', 'PAYLOAD', 'UPLINK', 'TERMINAL', 'OVERSEER'],
  ['INTRUSION', 'BACKDOOR', 'NIGHTFALL', 'COUNTERSPY', 'DARKNET', 'KEYSTONE'],
];

interface Slot {
  role: 'chain' | 'long' | 'hot' | 'junction' | 'deep' | 'vault';
  security: 1 | 2 | 3;
  pos: { row: number; col: number };
}

const clampSec = (n: number): 1 | 2 | 3 => Math.max(1, Math.min(3, n)) as 1 | 2 | 3;

function chainSlots(tier: number, rng: Rng, relax: number): Slot[] {
  const count = Math.max(2, G.chainNodesByTier[Math.min(tier, 10)]! - relax);
  const maxSec = Math.max(1, G.maxSecurityByTier[Math.min(tier, 10)]! - relax);
  const secs: (1 | 2 | 3)[] = [];
  for (let i = 0; i < count; i++) {
    const depthBonus = i >= count - 1 && tier >= 4 ? 1 : 0;
    const base = Math.min(maxSec, 1 + Math.floor((i / Math.max(1, count - 1)) * (maxSec - 1)) + depthBonus);
    const jitter = rng.chance(0.25) && base < maxSec ? 1 : 0;
    secs.push(clampSec(base + jitter));
  }
  secs.sort((a, b) => a - b);
  return secs.map((security, i) => ({ role: 'chain', security, pos: { row: i + 1, col: 1 } }));
}

function forkSlots(tier: number, relax: number): Slot[] {
  const maxSec = Math.max(1, G.maxSecurityByTier[Math.min(tier, 10)]! - relax);
  const low = clampSec(maxSec - 1);
  const hot = clampSec(maxSec);
  const slots: Slot[] = [
    { role: 'long', security: low, pos: { row: 1, col: 0 } },
    { role: 'long', security: low, pos: { row: 2, col: 0 } },
    { role: 'hot', security: hot, pos: { row: 1, col: 2 } },
    { role: 'junction', security: low, pos: { row: 3, col: 1 } },
  ];
  if (tier >= G.deepNodeFromTier && relax === 0) slots.push({ role: 'deep', security: hot, pos: { row: 4, col: 1 } });
  slots.push({ role: 'vault', security: clampSec(maxSec + 1), pos: { row: 4, col: 2 } });
  return slots;
}

function familyFor(tier: number, security: 1 | 2 | 3, rng: Rng): PuzzleFamily {
  if (tier < G.cipherFromTier) {
    if (security === 1) return rng.chance(tier === 1 ? 0.35 : 0.5) ? 'portknock' : 'sequence';
    return rng.chance(0.5) ? 'portknock' : 'sequence';
  }
  if (security === 3) return rng.chance(0.6) ? 'cipher' : 'portknock';
  if (security === 2) return rng.pick(['portknock', 'cipher', 'cipher', 'sequence'] as const);
  return rng.chance(0.6) ? 'sequence' : 'portknock';
}

function answerFor(family: PuzzleFamily, tier: number, security: 1 | 2 | 3, rng: Rng): PuzzleAnswer {
  if (family === 'sequence') {
    const seq = generateSequence(rng, security);
    return { family, terms: seq.terms, answer: seq.answer, rule: seq.rule };
  }
  if (family === 'portknock') {
    const knockTier = Math.min(CONFIG.puzzle.knockLengthByTier.length - 1, security - 1 + Math.floor(tier / 4));
    return { family, ports: generateKnock(rng, knockTier) };
  }
  const word = rng.pick(CIPHER_WORDS_TIERS[Math.min(2, security - 1)]!);
  return { family, word, shift: rng.int(1, 25) };
}

function baseRoot(hostname: string): DirSpec {
  const root = Vfs.specRoot(hostname.toLowerCase(), [
    { name: 'srv', files: [], dirs: [] },
    { name: 'vault', files: [], dirs: [] },
  ]);
  return root;
}

function dir(root: DirSpec, path: string): DirSpec {
  let cur = root;
  for (const seg of Vfs.splitPath(path)) {
    cur.dirs ??= [];
    let next = cur.dirs.find((d) => d.name === seg);
    if (!next) {
      next = { name: seg, files: [], dirs: [] };
      cur.dirs.push(next);
    }
    cur = next;
  }
  return cur;
}

function uniqueName(root: DirSpec, wanted: string, rng: Rng, pool: string[]): string {
  const taken = new Set<string>();
  const visit = (d: DirSpec) => {
    d.files.forEach((f) => taken.add(f.name));
    d.dirs?.forEach(visit);
  };
  visit(root);
  if (!taken.has(wanted)) return wanted;
  const free = pool.filter((n) => !taken.has(n));
  if (free.length) return rng.pick(free);
  let i = 2;
  const [stem, ext] = wanted.includes('.') ? [wanted.slice(0, wanted.lastIndexOf('.')), wanted.slice(wanted.lastIndexOf('.'))] : [wanted, ''];
  while (taken.has(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

/** Visible cipher clue: the offset and a printed decoding strip — never the answer. */
export function wheelClue(hostname: string, shift: number): string {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return [
    `FACILITIES SERVICE TAG — cipher wheel for ${hostname}`,
    `wheel offset: ${shift}  (rotate each plaque letter BACK by ${shift})`,
    `  plaque: ${caesar(alpha, shift).split('').join(' ')}`,
    `  means : ${alpha.split('').join(' ')}`,
    `(do not remove from break room. facilities WILL find you.)`,
  ].join('\n');
}

export function generateMissionV2(desc: MissionDescriptor, drawSeed: string, relax = 0): MissionSpec {
  const tier = desc.tier;
  const rng = new Rng(`v2:${drawSeed}#${tier}#${desc.topology}/${desc.objective}/${desc.modifier ?? '-'}`);
  const a = rng.int(10, 199);
  const b = rng.int(0, 254);
  let c = rng.int(1, 240);
  const nextIp = () => `10.${a}.${b}.${(c++ % 254) + 1}`;
  const names = rng.shuffle(NODE_NAMES);

  const slots = desc.topology === 'fork' ? forkSlots(tier, relax) : chainSlots(tier, rng, relax);

  // --- nodes ---
  const nodes: MissionNodeSpec[] = [
    {
      id: 'n0',
      ip: nextIp(),
      hostname: names[0]!,
      security: 0,
      puzzleFamily: 'sequence',
      root: baseRoot(names[0]!),
      route: null,
      pos: { row: 0, col: 1 },
    },
  ];
  const puzzleAnswers: Record<string, PuzzleAnswer> = {};
  slots.forEach((slot, i) => {
    const id = `n${i + 1}`;
    const family = familyFor(tier, slot.security, rng);
    puzzleAnswers[id] = answerFor(family, tier, slot.security, rng);
    nodes.push({
      id,
      ip: nextIp(),
      hostname: names[i + 1]!,
      security: slot.security,
      puzzleFamily: family,
      root: baseRoot(names[i + 1]!),
      vault: slot.role === 'vault' || undefined,
      route: slot.role === 'long' ? 'long' : slot.role === 'hot' ? 'hot' : null,
      pos: slot.pos,
    });
  });
  const byRole = (role: Slot['role']) => nodes.filter((_, i) => i > 0 && slots[i - 1]!.role === role);

  // --- edges ---
  let edges: [string, string][];
  if (desc.topology === 'fork') {
    const [a1, a2] = byRole('long') as [MissionNodeSpec, MissionNodeSpec];
    const [h] = byRole('hot') as [MissionNodeSpec];
    const [j] = byRole('junction') as [MissionNodeSpec];
    const [k] = byRole('deep');
    const [v] = byRole('vault') as [MissionNodeSpec];
    edges = [
      ['n0', a1.id],
      [a1.id, a2.id],
      [a2.id, j.id],
      ['n0', h.id],
      [h.id, j.id],
      [j.id, v.id],
    ];
    if (k) edges.push([j.id, k.id]);
  } else {
    edges = chainEdges(nodes);
  }

  const core = nodes.filter((n) => n.id !== 'n0' && !n.vault);
  const deepest = core[core.length - 1]!;

  // --- plain files, logs, greed loot ---
  for (const n of nodes) {
    const srv = dir(n.root, '/srv');
    srv.files.push({
      name: rng.pick(['memo.txt', 'notes.md', 'tickets.txt', 'shift.log']),
      tag: 'plain',
      content: rng.pick(PLAIN_LORE),
    });
    const logDir = dir(n.root, '/var/log');
    const role = n.id === 'n0' ? 'entry' : slots[nodes.indexOf(n) - 1]!.role;
    const withLog =
      role === 'entry' ? true : role === 'hot' ? false : role === 'vault' ? true : role === 'long' ? n === byRole('long')[1] : rng.chance(0.65);
    if (withLog) {
      logDir.files.push({
        name: rng.pick(['auth.log', 'access.log', 'tracepipe.log']),
        tag: 'log',
        content: 'session records. foreign handshake signatures present.',
      });
    }
    const greedChance = role === 'long' ? 0.8 : role === 'hot' || role === 'entry' || role === 'vault' ? 0 : 0.5;
    if (rng.chance(greedChance)) {
      const where = rng.chance(0.5) ? '/srv' : '/vault';
      const name = uniqueName(n.root, rng.pick(LOOT_NAMES), rng, LOOT_NAMES);
      dir(n.root, where).files.push({
        name,
        tag: 'loot',
        value: Math.round(CONFIG.economy.cashPerFileBySecurity[n.security]! * 0.6),
      });
    }
    if (n.vault) {
      for (let i = 0; i < G.vaultLootFiles; i++) {
        const name = uniqueName(n.root, rng.pick(VAULT_LOOT), rng, VAULT_LOOT);
        dir(n.root, '/vault').files.push({ name, tag: 'loot', value: CONFIG.economy.cashPerFileBySecurity[3]! });
      }
    }
  }

  // --- objective ---
  const targetIds: string[] = [];
  let objective: ObjectiveSpec;
  let required = 0;
  if (desc.objective === 'flagged') {
    required = G.targetsByTier[Math.min(tier, 10)]!;
    let holders: MissionNodeSpec[];
    if (desc.topology === 'fork') {
      const k = byRole('deep')[0];
      const j = byRole('junction')[0]!;
      holders = [];
      const onJ = k ? Math.ceil(required / 2) : required;
      for (let i = 0; i < required; i++) holders.push(i < onJ ? j : k!);
    } else {
      holders = [];
      let placed = 0;
      core.forEach((n, i) => {
        if (placed < required && (i % 2 === 1 || core.length - i <= required - placed)) {
          holders.push(n);
          placed++;
        }
      });
      while (holders.length < required) holders.push(deepest);
    }
    holders.forEach((n, i) => {
      const id = `target-${i + 1}`;
      const where = rng.chance(0.5) ? '/srv' : '/vault';
      const name = uniqueName(n.root, rng.pick(LOOT_NAMES), rng, LOOT_NAMES);
      dir(n.root, where).files.push({
        name,
        tag: 'target',
        value: CONFIG.economy.cashPerFileBySecurity[n.security]!,
        targetId: id,
      });
      targetIds.push(id);
    });
    objective = { type: 'flagged', required, targetIds: [...targetIds] };
  } else if (desc.objective === 'dossier') {
    const subjects = rng.shuffle(SUBJECTS);
    const subject = subjects[0]!;
    const fileName = `${subject}.dossier`;
    const home = dir(deepest.root, '/srv/personnel');
    home.files.push({
      name: fileName,
      tag: 'target',
      value: CONFIG.economy.cashPerFileBySecurity[deepest.security]! + 120,
      targetId: 'dossier',
    });
    // Other dossiers are optional greed — the brief names the one that pays.
    home.files.push({
      name: `${subjects[1]!}.dossier`,
      tag: 'loot',
      value: Math.round(CONFIG.economy.cashPerFileBySecurity[deepest.security]! * 0.5),
    });
    home.files.push({
      name: 'index.txt',
      tag: 'plain',
      content: `personnel index — restricted\n  ${subjects[1]}: transferred\n  ${subject}: UNDER REVIEW (see ${fileName})\n  ${subjects[2]}: "do not ask"`,
    });
    targetIds.push('dossier');
    required = 1;
    objective = { type: 'dossier', targetId: 'dossier', nodeId: deepest.id, fileName, subject };
  } else {
    const payloadName = rng.pick(PAYLOADS);
    const drop = dir(deepest.root, '/opt/relay');
    drop.files.push({
      name: 'README.relay',
      tag: 'plain',
      content: 'relay spool. jobs dropped here run at the next sync.\n(ops: please stop dropping jobs here.)',
    });
    objective = { type: 'payload', payloadName, nodeId: deepest.id, dir: '/opt/relay' };
  }

  // --- cipher clues: on every approach node, reachable before the lock ---
  const rowOf = (n: MissionNodeSpec) => n.pos?.row ?? 0;
  for (const n of nodes) {
    const ans = puzzleAnswers[n.id];
    if (!ans || ans.family !== 'cipher') continue;
    const approaches = nodes.filter(
      (m) => m !== n && !m.vault && edges.some(([x, y]) => (x === n.id && y === m.id) || (y === n.id && x === m.id)) && rowOf(m) < rowOf(n)
    );
    for (const m of approaches) {
      dir(m.root, '/srv').files.push({
        name: `wheel_${n.hostname.toLowerCase()}.txt`,
        tag: 'plain',
        content: wheelClue(n.hostname, ans.shift),
        clueFor: n.id,
      });
    }
  }

  // --- words ---
  const codename =
    desc.mode === 'campaign'
      ? CAMPAIGN_CODENAMES[Math.min(tier, 10)]!
      : `${new Rng(`name:${desc.seed}`).pick(CUSTOM_ADJ)} ${new Rng(`noun:${desc.seed}`).pick(CUSTOM_NOUN)}`;
  const { brief, handlerLines } = words(desc, codename, objective, required, deepest, rng);
  const debrief =
    desc.mode === 'campaign'
      ? CAMPAIGN_DEBRIEFS[Math.min(tier, 10)]!
      : rng.pick(['Paid in full. Don\'t spend it all on keyboards.', 'Cold in, cold out. That\'s a career.', 'Nice work. I\'ll pretend I expected it.']);

  return {
    descriptor: { ...desc },
    draw: { seed: drawSeed, relax },
    kind: 'contract',
    index: tier,
    seed: drawSeed,
    name: codename,
    codename,
    brief,
    handlerLines,
    debrief,
    nodes,
    edges,
    objective,
    modifier: desc.modifier,
    targetIds,
    requiredTargets: required,
    puzzleAnswers,
  };
}

function words(
  desc: MissionDescriptor,
  codename: string,
  objective: ObjectiveSpec,
  required: number,
  deepest: MissionNodeSpec,
  rng: Rng
): { brief: string; handlerLines: string[] } {
  const goal =
    objective.type === 'flagged'
      ? `steal ${required} flagged file${required === 1 ? '' : 's'}`
      : objective.type === 'dossier'
        ? `pull ${objective.fileName} from ${deepest.hostname}`
        : `upload ${objective.payloadName} into ${objective.dir} on ${deepest.hostname}`;
  const route =
    desc.topology === 'fork'
      ? ' Two approaches meet at the junction: the long road has more, softer locks; the short one runs hot. A vault hangs off the end — optional, loud, lucrative.'
      : ' One chain, deeper is hotter.';
  const brief = `Objective: ${goal}.${route} Logs buy margin; disconnect under 50% for a clean exit.`;

  const opener = rng.pick([
    `"${codename}". Small shop, fat secrets.`,
    `"${codename}" just cleared escrow. Try to look professional.`,
    `New key for "${codename}". The owner has insurance; you have speed.`,
    `Broker says "${codename}" is quiet this week. Broker lies, but not always.`,
  ]);
  const ask =
    objective.type === 'flagged'
      ? rng.pick([
          `${required} flagged files, in and out. Logs are your friend.`,
          `Pull ${required}. Wipe what you touch. Watch the meter.`,
          `I need ${required} files and zero drama. Drama bills at half.`,
        ])
      : objective.type === 'dossier'
        ? `One file: ${objective.fileName}. The rest of that box is noise you may keep.`
        : `Plant ${objective.payloadName} in ${objective.dir} on ${deepest.hostname}. \`upload\` it from there. Don't make it weird.`;
  const lines = [opener, ask];
  if (desc.topology === 'fork') lines.push('Two doors this time. Pick the one that suits your nerves.');
  if (desc.modifier === 'noisy') lines.push(`Line's noisy tonight — transfers will scream. Hazard pay: +$${CONFIG.modifiers.noisy.bonus}.`);
  if (desc.modifier === 'patrol') lines.push(`A daemon's already walking their halls, and it's quick. Hazard pay: +$${CONFIG.modifiers.patrol.bonus}.`);
  return { brief, handlerLines: lines };
}

/** Minimal safe layout for a descriptor: all security-1 locks (validator fallback). */
export function generateSafeTemplate(desc: MissionDescriptor): MissionSpec {
  const spec = generateMissionV2(desc, `${desc.seed}~safe`, 3);
  for (const n of spec.nodes) {
    if (n.id === 'n0' || n.vault) continue;
    n.security = 1;
    n.puzzleFamily = 'sequence';
    spec.puzzleAnswers[n.id] = { family: 'sequence', terms: [2, 4, 6, 8], answer: 10, rule: 'constant step' };
    // a sequence lock needs no clue; drop wheel files that point at it
    for (const m of spec.nodes) {
      const srv = m.root.dirs?.find((d) => d.name === 'srv');
      if (srv) srv.files = srv.files.filter((f) => f.clueFor !== n.id);
    }
  }
  return spec;
}

/** Hide a cipher plaintext: legacy (gen 1) plaques printed the answer. */
export function redactLegacyPlaque(root: DirSpec): void {
  const visit = (d: DirSpec) => {
    for (const f of d.files) {
      if (f.name === 'plaque.txt' && f.content) {
        f.content = f.content.replace(/master lockword: .*\n/, 'master lockword: [scratched off]\n');
      }
    }
    d.dirs?.forEach(visit);
  };
  visit(root);
}

export type { FileSpec };
