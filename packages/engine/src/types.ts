import type { CONFIG } from './config.js';

/** Semantic color classes — the UI maps these onto the permanent color language
 *  (green = good, red = bad, amber = warning — PRD §13). */
export type Cls =
  | 'good'
  | 'bad'
  | 'warn'
  | 'info'
  | 'dim'
  | 'accent'
  | 'sys'
  | 'handler'
  | 'banner'
  | 'loot'
  | 'log';

export type Sfx =
  | 'ok'
  | 'err'
  | 'connect'
  | 'breachStart'
  | 'breachHit'
  | 'alarm'
  | 'busted'
  | 'clean'
  | 'hint'
  | 'skip'
  | 'cash'
  | 'type';

export type PrintStyle = 'type' | 'instant';

export interface PrintEvent {
  t: 'print';
  text: string;
  cls?: Cls;
  style?: PrintStyle;
}

export interface EngineEventBodyMap {
  print: PrintEvent;
  /** Clear the terminal scrollback. */
  clear: { t: 'clear' };
  /** Tutorial glow: the suggested next command (empty string clears the glow). */
  suggest: { t: 'suggest'; cmd: string };
  sfx: { t: 'sfx'; name: Sfx };
  shake: { t: 'shake'; power: number };
  flash: { t: 'flash'; kind: 'good' | 'bad' | 'alert' };
  glitch: { t: 'glitch' };
  /** HUD should re-read the snapshot. */
  state: { t: 'state' };
  /** Trace meter moved; UI pulses the meter and the audio alarm tracks `value`. */
  trace: { t: 'trace'; value: number; delta: number; cause: string };
  /** A live transfer progress rewrite (UI redraws the current line). */
  progress: { t: 'progress'; pct: number; label: string };
  /** Handler chat line for the HUD panel. */
  handler: { t: 'handler'; text: string };
  puzzleOpen: { t: 'puzzleOpen'; puzzle: PuzzleView };
  puzzleClose: { t: 'puzzleClose' };
  missionEnd: { t: 'missionEnd'; result: MissionResult };
}

export type EngineEvent = EngineEventBodyMap[keyof EngineEventBodyMap];

export type GameMode = 'boot' | 'home' | 'mission' | 'post';

export type MissionOutcome = 'clean' | 'messy' | 'busted' | 'aborted';

export interface MissionResult {
  outcome: MissionOutcome;
  missionName: string;
  /** Contract index (0 for tutorial). */
  index: number;
  seed: string;
  isTutorial: boolean;
  trace: number;
  cash: number;
  xp: number;
  filesStolen: number;
  filesRequired: number;
  logsWiped: number;
  cleanBonus: number;
  missionBonus: number;
  /** Trace breakdown for the post-mission "why" screen (PRD §16). */
  breakdown: { label: string; delta: number }[];
  rankBefore: string;
  rankAfter: string | null;
}

/* ---------------------------------- VFS ---------------------------------- */

export type FileTag = 'plain' | 'loot' | 'log' | 'target';

export interface FileSpec {
  name: string;
  tag: FileTag;
  /** Loot value in cash (loot/target files). */
  value?: number;
  /** cat-able content (lore, memos, cipher plaques). */
  content?: string;
  /** Target files carry a stable id for objective tracking. */
  targetId?: string;
}

export interface DirSpec {
  name: string;
  files: FileSpec[];
  dirs?: DirSpec[];
}

/* -------------------------------- Missions -------------------------------- */

export type PuzzleFamily = 'sequence' | 'portknock' | 'cipher';

export interface MissionNodeSpec {
  id: string;
  ip: string;
  hostname: string;
  /** 0 = entry foothold, 1..3 = puzzle tier. */
  security: 0 | 1 | 2 | 3;
  puzzleFamily: PuzzleFamily;
  root: DirSpec;
}

export interface MissionSpec {
  kind: 'contract' | 'tutorial';
  index: number; // 1..10, 0 for tutorial
  seed: string;
  name: string;
  codename: string;
  brief: string;
  handlerLines: string[];
  /** Linear chain: nodes[i+1] is reachable from nodes[i] (PRD §15 MVP topology). */
  nodes: MissionNodeSpec[];
  /** ids of loot files that count toward the objective, in steal-order. */
  targetIds: string[];
  requiredTargets: number;
  /** Precomputed puzzle payloads keyed by node id (validator + tutorial force-success need answers). */
  puzzleAnswers: Record<string, PuzzleAnswer>;
}

/** The generator's answer key for a node's lock. Tests and the solvability
 *  validator read this; the runtime puzzle UI never exposes it. */
export type PuzzleAnswer =
  | { family: 'sequence'; terms: number[]; answer: number; rule: string }
  | { family: 'portknock'; ports: number[] }
  | { family: 'cipher'; word: string; shift: number };

/* -------------------------------- Puzzles -------------------------------- */

/** What the UI (and the player) may see about an open puzzle. */
export interface PuzzleView {
  family: PuzzleFamily;
  /** Human prompt, e.g. "Packet interval lock: [2] [4] [8] [??]". */
  prompt: string;
  timeLimit: number;
  timeLeft: number;
  attempts: number;
  /** port-knock: ports visible only while the sequence is still glowing. */
  knockPortsVisible?: boolean;
  knockPorts?: number[];
  /** cipher: the scrambled plaque text. */
  cipherText?: string;
}

export interface PuzzleState {
  family: PuzzleFamily;
  nodeId: string;
  security: 1 | 2 | 3;
  timeLimit: number;
  elapsed: number;
  attempts: number;
  /** Tutorial: the first graded attempt is a forced success (PRD §11). */
  forcedSuccess: boolean;
  sequence?: { terms: number[]; answer: number; rule: string };
  knock?: { ports: number[]; entered: number[]; showLeft: number };
  cipher?: { word: string; shift: number; hinted: boolean };
}

/* ------------------------------- Snapshot -------------------------------- */

export interface NodeView {
  id: string;
  ip: string;
  hostname: string;
  security: 0 | 1 | 2 | 3;
  status: 'entry' | 'locked' | 'breached';
  isCurrent: boolean;
  /** True when this node still holds at least one objective target file. */
  hasTarget: boolean;
  lootValue: number;
  logsLeft: number;
  scanned: boolean;
}

export interface TargetView {
  id: string;
  name: string;
  nodeId: string;
  stolen: boolean;
}

export interface PuzzleSnapshot {
  family: PuzzleFamily;
  /** Node whose lock is open (differs from currentNodeId — you haven't taken it yet). */
  nodeId: string;
  prompt: string;
  timeLeft: number;
  timeLimit: number;
  attempts: number;
  knockPortsVisible: boolean;
  knockPorts: number[];
  cipherText: string;
}

export interface Snapshot {
  mode: GameMode;
  prompt: string;
  profile: {
    cash: number;
    xp: number;
    rank: string;
    contractsDone: number;
    tutorialDone: boolean;
    upgrades: Record<string, number>;
  };
  settings: {
    volume: number;
    muted: boolean;
    crt: boolean;
    /** User motion preference; UI also honors prefers-reduced-motion. */
    motion: boolean;
  };
  suggest: string;
  mission: null | {
    isTutorial: boolean;
    index: number;
    name: string;
    codename: string;
    seed: string;
    trace: number;
    phase: 'quiet' | 'watchdog' | 'alert';
    tools: { proxy: number; decoy: number };
    nodes: NodeView[];
    currentNodeId: string;
    watchdogNodeId: string | null;
    targets: TargetView[];
    stolen: number;
    required: number;
    sessionCash: number;
    sessionXp: number;
    logsLeft: number;
    puzzle: PuzzleSnapshot | null;
    transferLabel: string | null;
  };
  lastResult: MissionResult | null;
}

/** Aggregate, observation-only counters for the PRD §17 tuning loop.
 *  The engine bumps these as it already processes events; nothing here
 *  influences game outcomes, determinism, or the mission RNG. */
export interface Telemetry {
  runsStarted: number;
  runsEnded: number;
  runsCompleted: number;
  runsBusted: number;
  runsShort: number; // disconnected with fewer than the required files
  locksEncountered: number;
  locksSolved: number;
  locksSkipped: number;
  lockFailures: number; // wrong answers + burnt fuses
  hintsBought: number;
  proxiesBurned: number;
  decoysBurned: number;
  /** active-play seconds until the first breach of a run (sum + samples) */
  firstBreachSum: number;
  firstBreachCount: number;
  /** final trace at disconnect (sum + samples) */
  finalTraceSum: number;
  finalTraceCount: number;
  /** session bookkeeping: a new session starts after `sessionGapMs` idle */
  sessions: number;
  lastPlayedAt: number;
}

export const TELEMETRY_DEFAULT: Telemetry = {
  runsStarted: 0,
  runsEnded: 0,
  runsCompleted: 0,
  runsBusted: 0,
  runsShort: 0,
  locksEncountered: 0,
  locksSolved: 0,
  locksSkipped: 0,
  lockFailures: 0,
  hintsBought: 0,
  proxiesBurned: 0,
  decoysBurned: 0,
  firstBreachSum: 0,
  firstBreachCount: 0,
  finalTraceSum: 0,
  finalTraceCount: 0,
  sessions: 0,
  lastPlayedAt: 0,
};

/** Persistence blob (PRD §4.3): progression autosaves after missions and on blur,
 *  and a mid-mission session snapshot offers "resume" on return. */
export interface SaveBlob {
  version: 1;
  profile: {
    cash: number;
    xp: number;
    contractsDone: number;
    tutorialDone: boolean;
    /** owned shop upgrades: id → level */
    upgrades: Record<string, number>;
    telemetry: Telemetry;
  };
  settings: Snapshot['settings'];
  history: string[];
  session: SessionSave | null;
}

export interface SessionSave {
  kind: 'contract' | 'tutorial';
  index: number;
  seed: string;
  trace: number;
  rngState: number;
  tools: { proxy: number; decoy: number };
  currentNodeId: string;
  breached: string[];
  downloaded: string[];
  removed: string[];
  scanned: boolean;
  watchdogNodeId: string | null;
  watchdogTimer: number;
  decoyTimer: number;
  puzzle: (Pick<PuzzleState, 'family' | 'nodeId' | 'elapsed' | 'attempts' | 'forcedSuccess'> & {
    sequence?: NonNullable<PuzzleState['sequence']>;
    knock?: { ports: number[]; entered: number[]; showLeft: number };
    cipher?: NonNullable<PuzzleState['cipher']>;
  }) | null;
  transfer: { fileId: string; progress: number } | null;
  /** Mid-run earnings so a resume doesn't lose the haul so far. */
  progress: {
    sessionCash: number;
    sessionXp: number;
    downloadsCount: number;
    downloadedValue: number;
    logsWiped: number;
  };
}

export type TraceCause =
  | 'connect'
  | 'breach'
  | 'breach-watchdog'
  | 'puzzle-fail'
  | 'download'
  | 'idle'
  | 'log-wipe'
  | 'skip'
  | 'proxy-hop'
  | 'scan';

export type Config = typeof CONFIG;
