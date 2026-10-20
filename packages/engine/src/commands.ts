/**
 * Command grammar (PRD §9): the 8 MVP verbs plus the puzzle/skip/hint/tools
 * verbs and home-terminal shell commands. This module is *data*: usage strings,
 * themed manual pages, aliases, and forgiving-parse helpers. Behavior lives in game.ts.
 */
import type { GameMode } from './types.js';

export interface CommandMeta {
  name: string;
  aliases: string[];
  usage: string;
  summary: string;
  /** Modes where the verb is offered by help/autocomplete. */
  modes: GameMode[];
  /** Manual page: a leaked internal doc, written in-world (PRD §3.2 "diegetic help"). */
  man: string[];
}

const ANY: GameMode[] = ['home', 'mission', 'post'];

export const COMMANDS: CommandMeta[] = [
  {
    name: 'help',
    aliases: ['?', 'verbs'],
    usage: 'help',
    summary: 'one-screen verb list',
    modes: ANY,
    man: [
      'GRID TRUST FIELD CARD 07 — "when lost"',
      '',
      '  help          this card. every verb you get paid for.',
      '  man <verb>    the long version of a verb.',
      '',
      '  everything else is on the other cards. type `man <verb>`.',
    ],
  },
  {
    name: 'man',
    aliases: [],
    usage: 'man <cmd>',
    summary: 'manual page for a verb',
    modes: ANY,
    man: [
      'GRID TRUST FIELD CARD 06 — "read the manual"',
      '',
      '  man <verb>   opens the internal doc page for a verb.',
      '',
      '  these pages were written by people who no longer work here.',
      '  treat them accordingly.',
    ],
  },
  {
    name: 'contracts',
    aliases: ['jobs', 'missions'],
    usage: 'contracts',
    summary: 'list contracts and their status',
    modes: ['home', 'post'],
    man: [
      'BROKER MEMO — "the board"',
      '',
      '  contracts        lists every contract: cleared, ready, locked.',
      '  run <n>          accepts contract n (must be unlocked).',
      '  run seed <SEED>  accepts a custom job by seed. same seed, same job, always.',
      '  tutorial         reruns the guided warm-up.',
      '',
      '  contracts unlock in order. the Broker does not believe in skipping ahead.',
    ],
  },
  {
    name: 'run',
    aliases: [],
    usage: 'run <n> | run seed <SEED>',
    summary: 'start a contract by number or seed',
    modes: ['home', 'post'],
    man: [
      'BROKER MEMO — "accepting work"',
      '',
      '  run 3            connect to contract 3.',
      '  run seed 7F3K-09XA   custom job. identical seed → identical network.',
      '',
      '  when you jack in, the clock is your pulse: TRACE creeps up while you',
      '  stand still. watch the meter. plan before you plug in.',
    ],
  },
  {
    name: 'tutorial',
    aliases: [],
    usage: 'tutorial',
    summary: 'guided warm-up job (~90s, cannot be failed)',
    modes: ['home'],
    man: [
      'BROKER MEMO — "for rookies"',
      '',
      '  tutorial   a scripted job. the terminal will glow around the next command;',
      '             press TAB to fill it in. one lock is pre-disarmed for you.',
      '  skipintro  leaves the tutorial at any time.',
    ],
  },
  {
    name: 'shop',
    aliases: ['market'],
    usage: 'shop',
    summary: 'the Broker\'s market: spend cash on permanent rig upgrades',
    modes: ['home', 'post'],
    man: [
      'THE BROKER\'S MARKET — "money is ammunition"',
      '',
      '  shop         list the catalog: effect, level, price.',
      '  buy <id>     acquire one level. effects apply to every future job.',
      '',
      '  no refunds. the Broker does not do refunds. the Broker barely does verbs.',
    ],
  },
  {
    name: 'buy',
    aliases: [],
    usage: 'buy <id>',
    summary: 'acquire a shop upgrade',
    modes: ['home', 'post'],
    man: [
      'THE BROKER\'S MARKET — "acquisition"',
      '',
      '  buy relay       +1 proxy hop per job.',
      '  buy drone       +1 decoy per job.',
      '  buy overclock   transfers run 15% faster per level (trace-lighter too).',
      '  buy ghosting    idle trace creep −20% per level.',
      '  buy crowbar     lock fuses +8s per level.',
      '  buy insider     hints cost 40% less.',
    ],
  },
  {
    name: 'stats',
    aliases: ['analytics'],
    usage: 'stats',
    summary: 'your wire analytics, scored against the grid\'s tuning targets',
    modes: ['home', 'post'],
    man: [
      'WIRE ANALYTICS — "know thy operator"',
      '',
      '  stats    your career numbers: completion rate, time to first breach,',
      '           lock skip rate, tool usage, runs per session — each scored',
      '           against the tuning targets the grid watches.',
      '',
      '  ✓ on target   ⚠ off target. the grid adjusts to keep you in flow.',
    ],
  },
  {
    name: 'profile',
    aliases: ['status', 'whoami'],
    usage: 'profile',
    summary: 'cash, XP and rank title',
    modes: ANY,
    man: [
      'BROKER MEMO — "your cut"',
      '',
      '  profile    shows cash, XP, and what the community calls you this week.',
      '',
      '  ranks: Script Kiddie → Operator → Breacher → Ghost → Elite Operator.',
      '  busted jobs keep half the XP and none of the cash.',
    ],
  },
  {
    name: 'settings',
    aliases: ['config'],
    usage: 'settings [key] [value]',
    summary: 'volume, mute, CRT overlay, motion',
    modes: ANY,
    man: [
      'TERMINAL SERVICE BULLETIN — "comfort"',
      '',
      '  settings               show current settings.',
      '  settings volume 0.5    synth audio level, 0.0 – 1.0.',
      '  settings mute on|off   kill all audio.',
      '  settings crt on|off    scanline + vignette overlay.',
      '  settings motion on|off screen shake and glitch effects.',
      '',
      '  settings persist between sessions. the terminal remembers so you type less.',
    ],
  },
  {
    name: 'scan',
    aliases: ['sc', 'recon'],
    usage: 'scan',
    summary: 'map the local network: nodes, security, loot',
    modes: ['mission'],
    man: [
      'OP-CYCLOPS DOC v3 — "sweep"',
      '',
      '  scan   passive sweep of the local chain. renders every node on the HUD map:',
      '         security tier, loot estimate, logs.',
      '',
      '  scanning is passive but not free — you are still standing in someone',
      '  else\'s network while you read the map.',
    ],
  },
  {
    name: 'connect',
    aliases: ['ssh', 'hop'],
    usage: 'connect <ip>',
    summary: 'hop your session to an owned node (+2 trace)',
    modes: ['mission'],
    man: [
      'GRID TRUST FIELD CARD 11 — "movement"',
      '',
      '  connect <ip>   moves your session onto a node you already own.',
      '                 costs a baseline +2 trace per hop.',
      '',
      '  breaching a node connects you automatically. connect is for going back',
      '  for files you passed on the way in.',
    ],
  },
  {
    name: 'breach',
    aliases: ['exploit', 'crack-node'],
    usage: 'breach <ip>',
    summary: 'attack a node\'s firewall lock (puzzle)',
    modes: ['mission'],
    man: [
      'OP-CYCLOPS DOC v3 — "the lock"',
      '',
      '  breach <ip>  attacks the firewall of an adjacent node. a lock opens',
      '               onto your terminal:',
      '',
      '    packet interval lock   [2] [4] [8] [??]  →  input <the next number>',
      '    the four terms follow ONE rule. only four rules exist:',
      '      · constant step    2 5 8 11   → 14     (same + every time)',
      '      · constant ratio   3 9 27 81  → 243    (same × every time)',
      '      · last two sum     2 5 7 12   → 19     (2+5=7, 5+7=12, …)',
      '      · perfect squares  4 9 16 25  → 36     (2² 3² 4² 5² → 6²)',
      '',
      '    knock sequence         ports glow, then go dark → knock <p1> <p2> ...',
      '    cipher plaque          "FRQWLQXH" → input <decoded word>',
      '                           (check plaque.txt on the node for the offset)',
      '',
      '  the lock is time-boxed. timeout = failed breach (+15 trace).',
      '  wrong answers sting (+15) but the lock stays open until the fuse ends.',
      '  skip ends it (+25 trace, node opens). hint buys a clue (cash).',
    ],
  },
  {
    name: 'ls',
    aliases: ['dir'],
    usage: 'ls [path]',
    summary: 'list files on the owned node',
    modes: ['mission'],
    man: [
      'GRID TRUST FIELD CARD 04 — "looking around"',
      '',
      '  ls [path]   list a directory. amber = logs, green = loot, tagged TARGET',
      '              files are what the contract pays for.',
      '',
      '  loot you download pays. logs you rm buy trace margin. everything else',
      '  is atmosphere.',
    ],
  },
  {
    name: 'cd',
    aliases: [],
    usage: 'cd <dir>',
    summary: 'change directory',
    modes: ['mission'],
    man: [
      'GRID TRUST FIELD CARD 04 — "movement, indoor"',
      '',
      '  cd <dir>    descend. cd .. climbs back out.',
      '',
      '  most value lives in /srv and /vault. trouble lives in /var/log.',
    ],
  },
  {
    name: 'cat',
    aliases: ['read'],
    usage: 'cat <file>',
    summary: 'read a file (lore, memos, plaques, clues)',
    modes: ['mission'],
    man: [
      'GRID TRUST FIELD CARD 05 — "reading"',
      '',
      '  cat <file>  prints a file. memos and plaques sometimes contain what the',
      '              locks want — the plaque.txt service tags carry cipher offsets.',
      '',
      '  encrypted blobs will not cat. they must be downloaded to matter.',
    ],
  },
  {
    name: 'download',
    aliases: ['dl', 'scp', 'get', 'exfil'],
    usage: 'download <file>',
    summary: 'exfiltrate a file (+5 trace/s while transferring)',
    modes: ['mission'],
    man: [
      'GRID TRUST FIELD CARD 09 — "taking it with you"',
      '',
      '  download <file>  copies a file to your rig. the transfer is LOUD:',
      '                   +5 trace per second for as long as it runs.',
      '',
      '  TARGET files are the contract. everything else with a $ tag is greed.',
      '  greed is legal. greed has a meter.',
    ],
  },
  {
    name: 'rm',
    aliases: ['del', 'wipe', 'shred'],
    usage: 'rm <path>',
    summary: 'delete files; logs lower trace by 8',
    modes: ['mission'],
    man: [
      'GRID TRUST FIELD CARD 08 — "housekeeping"',
      '',
      '  rm /var/log/auth.log   deletes a log. every wiped log lowers TRACE by 8.',
      '',
      '  flagged TARGET files are contract-locked and cannot be deleted.',
      '  you are a thief, not an arsonist. the Broker is clear on this.',
    ],
  },
  {
    name: 'disconnect',
    aliases: ['exit', 'quit', 'logout', 'escape'],
    usage: 'disconnect',
    summary: 'end the run and score it',
    modes: ['mission'],
    man: [
      'GRID TRUST FIELD CARD 10 — "going home"',
      '',
      '  disconnect   cuts the tunnel and settles the contract.',
      '',
      '  below 50% trace: CLEAN EXIT. payout ×1.5.',
      '  above 50%: you keep the loot but the Broker smiles less.',
      '  at 100% the grid keeps everything. do not be there when it happens.',
    ],
  },
  {
    name: 'input',
    aliases: ['answer', 'decode'],
    usage: 'input <value>',
    summary: 'answer an open lock (sequence / cipher)',
    modes: ['mission'],
    man: [
      'OP-CYCLOPS DOC v3 — "talking to locks"',
      '',
      '  input <value>   your answer to an open sequence or cipher lock.',
      '                  wrong answers sting (+15 trace) but the lock stays open',
      '                  until the fuse burns.',
    ],
  },
  {
    name: 'knock',
    aliases: [],
    usage: 'knock <p1> <p2> ...',
    summary: 'repeat a glowing port sequence',
    modes: ['mission'],
    man: [
      'OP-CYCLOPS DOC v3 — "port knocking"',
      '',
      '  knock 22 443 8080   repeats a knock sequence in order, all ports at once.',
      '  you may also knock one port at a time; the buffer remembers.',
      '  wrong ports sting (+15 trace). watch the glow, then type from memory.',
    ],
  },
  {
    name: 'skip',
    aliases: ['bypass'],
    usage: 'skip',
    summary: 'force an open lock open (+25 trace)',
    modes: ['mission'],
    man: [
      'OP-CYCLOPS DOC v3 — "the blunt instrument"',
      '',
      '  skip   bypasses the open lock entirely. the node opens. TRACE +25.',
      '',
      '  there is no shame in it. there is only the meter.',
    ],
  },
  {
    name: 'hint',
    aliases: [],
    usage: 'hint',
    summary: 'buy a clue for the open lock (cash)',
    modes: ['mission'],
    man: [
      'BROKER MEMO — "consulting fees"',
      '',
      '  hint   the Broker\'s analyst glances at your lock and mutters something',
      '         useful. costs cash, never trace.',
      '',
      '  broke? skip always works. trace is cheaper than failure.',
    ],
  },
  {
    name: 'proxy',
    aliases: ['proxyhop', 'proxy-hop'],
    usage: 'proxy hop',
    summary: 'burn a one-shot proxy: −25 trace',
    modes: ['mission'],
    man: [
      'SMUGGLER\'S COMPANION — "buying distance"',
      '',
      '  proxy hop   reroutes your tunnel through a burner relay. TRACE −25.',
      '              one relay per job. when it is gone, it is gone.',
      '',
      '  veterans save it for the walk out. amateurs save it for never.',
    ],
  },
  {
    name: 'decoy',
    aliases: ['decoy-node'],
    usage: 'decoy',
    summary: 'feed the watchdog a fake target (~25s)',
    modes: ['mission'],
    man: [
      'SMUGGLER\'S COMPANION — "throwing meat"',
      '',
      '  decoy   lights up a fake intrusion elsewhere. the watchdog daemon goes',
      '          to sniff it for ~25 seconds, and its current node stops charging',
      '          double while you work.',
    ],
  },
  {
    name: 'resume',
    aliases: [],
    usage: 'resume',
    summary: 'reconnect to a mid-run session after a reload',
    modes: ['home'],
    man: [
      'TERMINAL SERVICE BULLETIN — "recovery"',
      '',
      '  resume   if the terminal died mid-job, this puts you back on the wire',
      '           exactly where you were. abandon drops the job instead.',
    ],
  },
  {
    name: 'abandon',
    aliases: [],
    usage: 'abandon',
    summary: 'drop a recoverable session',
    modes: ['home'],
    man: [
      'TERMINAL SERVICE BULLETIN — "recovery, the other button"',
      '',
      '  abandon   erases the recoverable session. nothing is scored.',
      '            the Broker does not pay for jobs you walk away from.',
    ],
  },
  {
    name: 'retry',
    aliases: ['again'],
    usage: 'retry',
    summary: 'instant rerun of the job you just finished',
    modes: ['post'],
    man: [
      'BROKER MEMO — "again, but angrier"',
      '',
      '  retry   reruns the exact seed you just played. same network, same locks.',
      '          enter also works — one keypress, back on the wire.',
    ],
  },
  {
    name: 'clear',
    aliases: ['cls'],
    usage: 'clear',
    summary: 'clear the terminal',
    modes: ANY,
    man: ['TERMINAL SERVICE BULLETIN — "a clean slate"\n\n  clear   wipes the scrollback. history stays.'],
  },
  {
    name: 'wipe',
    aliases: ['reset'],
    usage: 'wipe confirm',
    summary: 'erase all progression (requires confirm)',
    modes: ['home'],
    man: [
      'TERMINAL SERVICE BULLETIN — "burner hygiene"',
      '',
      '  wipe confirm   erases cash, XP, ranks, everything. the terminal becomes',
      '                 the burner it was on day zero. there is no undo.',
    ],
  },
  {
    name: 'about',
    aliases: ['cybergrid'],
    usage: 'about',
    summary: 'what is this thing',
    modes: ANY,
    man: [
      'CyberGrid — a tension game disguised as a terminal.',
      'steal the files, watch the meter, and be somewhere else before 100%.',
    ],
  },
];

export function lookupCommand(word: string): CommandMeta | null {
  const w = word.toLowerCase();
  for (const c of COMMANDS) {
    if (c.name === w || c.aliases.includes(w)) return c;
  }
  return null;
}

export function commandsForMode(mode: GameMode): CommandMeta[] {
  return COMMANDS.filter((c) => c.modes.includes(mode));
}

/** Levenshtein distance, small strings only. */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length]![b.length]!;
}

/** Forgiving parse (PRD §3.2): near-miss verbs get a "did you mean". */
export function didYouMean(word: string, mode: GameMode): string | null {
  const w = word.toLowerCase();
  let best: string | null = null;
  let bestD = 3;
  for (const c of commandsForMode(mode)) {
    const d = Math.min(
      editDistance(w, c.name),
      ...c.aliases.map((a) => editDistance(w, a))
    );
    if (d < bestD) {
      bestD = d;
      best = c.name;
    }
  }
  return bestD <= (w.length <= 4 ? 1 : 2) ? best : null;
}

export function manPage(meta: CommandMeta): string {
  return [`───[ man ${meta.name} ]────────────────────────────`, ...meta.man, `───[ usage: ${meta.usage} ]─────`].join('\n');
}
