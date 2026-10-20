import type { CONFIG } from './config.js';

/** Semantic color classes — the UI maps these onto the permanent color language
 *  (green = good, red = bad, amber = warning — PRD §13). */
export type Cls =
  | 'good'
  | 'echo'
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
  /** The suggested next command (empty string clears the glow). */
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
  /** Short status line for assistive tech (phase changes, locks, outcomes) —
   *  never per-frame updates. */
  announce: { t: 'announce'; text: string };
  puzzleOpen: { t: 'puzzleOpen'; puzzle: PuzzleView };
  puzzleClose: { t: 'puzzleClose' };
  missionEnd: { t: 'missionEnd'; result: MissionResult };
}

export type EngineEvent = EngineEventBodyMap[keyof EngineEventBodyMap];

export type GameMode = 'boot' | 'home' | 'mission' | 'post';

/* ------------------------------ identity ------------------------------ */

/** campaign = one of the ten fixed contracts; custom = any seed (practice);
 *  daily = the UTC-date challenge; tutorial = the scripted warm-up. */
export type MissionMode = 'campaign' | 'custom' | 'daily' | 'tutorial';
export type Topology = 'chain' | 'fork';
export type ObjectiveType = 'flagged' | 'dossier' | 'payload';
export type ModifierId = 'noisy' | 'patrol';

/** What a mission *is*: enough to regenerate it exactly on any profile. */
export interface MissionDescriptor {
  /** Generation + rules version. 1 = legacy linear chain, 2 = graph missions. */
  gen: 1 | 2;
  mode: MissionMode;
  /** The original generation input, verbatim (case, punctuation, Unicode kept). */
  seed: string;
  /** Fixed difficulty, 1..10 (the contract index for campaign jobs). */
  tier: number;
  /** Layout selection — part of the identity so redraws never change it. */
  topology: Topology;
  objective: ObjectiveType;
  modifier: ModifierId | null;
}

/* ---------------------------------- VFS ---------------------------------- */

export type FileTag = 'plain' | 'loot' | 'log' | 'target' | 'payload';

export interface FileSpec {
  name: string;
  tag: FileTag;
  /** Loot value in cash (loot/target files). */
  value?: number;
  /** cat-able content (lore, memos, cipher clues). */
  content?: string;
  /** Target files carry a stable id for objective tracking. */
  targetId?: string;
  /** Cipher clue files name the lock node they unlock (recon lists them). */
  clueFor?: string;
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
  /** Optional side branch with extra loot — never required. */
  vault?: boolean;
  /** Fork missions label each approach so recon can describe the choice. */
  route?: 'long' | 'hot' | null;
  /** Map layout cell: row = depth band, col = lane (0..2). */
  pos?: { row: number; col: number };
}

export type ObjectiveSpec =
  | { type: 'flagged'; required: number; targetIds: string[] }
  | { type: 'dossier'; targetId: string; nodeId: string; fileName: string; subject: string }
  | { type: 'payload'; payloadName: string; nodeId: string; dir: string };

export interface MissionSpec {
  /** Exact identity — retry, resume, share and records all key off this. */
  descriptor: MissionDescriptor;
  /** The validated draw: generation input after deterministic redraws. */
  draw: { seed: string; relax: number };
  kind: 'contract' | 'tutorial';
  /** Contract index for campaign, tier for custom/daily, 0 for the tutorial. */
  index: number;
  /** Kept for legacy callers: same as draw.seed. */
  seed: string;
  name: string;
  codename: string;
  brief: string;
  handlerLines: string[];
  /** Short Broker sign-off on success (mission-specific debrief). */
  debrief: string;
  nodes: MissionNodeSpec[];
  /** Undirected links by node id. Entry node is always `n0`. */
  edges: [string, string][];
  objective: ObjectiveSpec;
  modifier: ModifierId | null;
  /** Flagged-file target ids (empty for other objectives). */
  targetIds: string[];
  requiredTargets: number;
  /** Generator answer key keyed by node id (validator + tutorial need answers). */
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

/* ------------------------------- Equipment ------------------------------- */

export type ModuleId = 'burst' | 'quiet';

/** Everything that changes a run's numbers, frozen when the run starts. */
export interface Loadout {
  module: ModuleId | null;
  /** Permanent upgrade levels at run start (shop id → level). */
  upgrades: Record<string, number>;
}

/* ------------------------------- Results --------------------------------- */

/** clean / hot = objective complete (exit quality differs); early = the player
 *  disconnected without finishing; busted = trace hit 100%. */
export type MissionOutcome = 'clean' | 'hot' | 'early' | 'busted';
export type ExitQuality = 'clean' | 'hot' | 'busted';

export interface MissionResult {
  runId: string;
  outcome: MissionOutcome;
  objectiveComplete: boolean;
  exit: ExitQuality;
  missionName: string;
  /** Contract index (0 for tutorial; tier for custom/daily). */
  index: number;
  descriptor: MissionDescriptor;
  /** Exact share/replay code for this mission (empty for the tutorial). */
  code: string;
  /** Kept for legacy callers: the descriptor seed. */
  seed: string;
  isTutorial: boolean;
  /** daily: whether this run was the recorded attempt or practice. */
  practice: boolean;
  /** Authoritative final trace (unrounded) and the floored display value. */
  traceExact: number;
  trace: number;
  peakTrace: number;
  cash: number;
  xp: number;
  /** Active play seconds (never counts time with the app closed). */
  activeSeconds: number;
  filesStolen: number;
  filesRequired: number;
  objectiveLabel: string;
  logsWiped: number;
  lootCash: number;
  cleanBonus: number;
  missionBonus: number;
  modifierBonus: number;
  vaultLooted: boolean;
  loadout: Loadout;
  /** Trace breakdown for the post-mission "why" screen (PRD §16). */
  breakdown: { label: string; delta: number }[];
  /** False when part of the run predates detailed trace accounting. */
  breakdownComplete: boolean;
  rankBefore: string;
  rankAfter: string | null;
  /** Unlocks earned by this run's rank-up (module ids). */
  unlocked: string[];
  campaignCleared: boolean;
  /** ISO timestamp the run finished. */
  finishedAt: string;
}

/* ------------------------------- Records --------------------------------- */

export interface RecordEntry {
  runId: string;
  /** Comparable bucket: identity + rules + loadout. */
  key: string;
  code: string;
  label: string;
  mode: MissionMode;
  practice: boolean;
  outcome: MissionOutcome;
  objectiveComplete: boolean;
  cash: number;
  activeSeconds: number;
  finalTrace: number;
  loadoutLabel: string;
  date: string;
}

export interface RecordsState {
  /** Best comparable result per key. */
  best: Record<string, RecordEntry>;
  /** Most recent finished runs, newest first. */
  recent: RecordEntry[];
}

export interface DailyAttempt {
  date: string;
  runId: string;
  status: 'live' | 'finished' | 'abandoned';
  outcome?: MissionOutcome;
  cash?: number;
  finalTrace?: number;
  activeSeconds?: number;
}

/* ------------------------------- Snapshot -------------------------------- */

export interface NodeView {
  id: string;
  ip: string;
  hostname: string;
  security: 0 | 1 | 2 | 3;
  status: 'entry' | 'locked' | 'breached';
  isCurrent: boolean;
  /** Locked and linked to the node you're on — `breach` works from here. */
  reachable: boolean;
  /** Locked and linked to any owned node. */
  frontier: boolean;
  /** True when this node still holds an objective file / drop point. */
  hasTarget: boolean;
  objectiveRole: 'target' | 'dossier' | 'drop' | null;
  lootValue: number;
  logsLeft: number;
  scanned: boolean;
  vault: boolean;
  route: 'long' | 'hot' | null;
  /** Expected breach trace right now (doubles while the watchdog sits here). */
  breachCost: number;
  lockFamily: PuzzleFamily | null;
  /** Hostnames of owned/visible nodes carrying this node's cipher clue. */
  clueAt: string[];
  neighbors: string[];
  depth: number;
  lane: number;
}

export interface TargetView {
  id: string;
  name: string;
  nodeId: string;
  stolen: boolean;
}

export interface PuzzleSnapshot {
  family: PuzzleFamily;
  familyLabel: string;
  /** Node whose lock is open (differs from currentNodeId — you haven't taken it yet). */
  nodeId: string;
  hostname: string;
  prompt: string;
  timeLeft: number;
  timeLimit: number;
  attempts: number;
  knockPortsVisible: boolean;
  /** sequence locks: the visible terms (the next one is the answer) */
  sequenceTerms: number[];
  knockPorts: number[];
  knockEntered: number;
  knockLength: number;
  /** Port-knock after the glow: a memory challenge. */
  memory: boolean;
  cipherText: string;
  /** Cipher: the decoding strip, once the clue has been read or bought. */
  cipherWheel: string | null;
  clueHint: string | null;
  hintCost: number;
  answerUsage: string;
}

export interface TransferSnapshot {
  op: 'download' | 'upload';
  file: string;
  pct: number;
  secondsLeft: number;
  traceRate: number;
  watched: boolean;
}

export interface ObjectiveSnapshot {
  type: ObjectiveType;
  label: string;
  done: boolean;
  progress: string;
  /** Payload missions: the file you carry and where it goes. */
  payload?: { name: string; host: string; dir: string; placed: boolean };
}

export interface ModifierSnapshot {
  id: ModifierId;
  name: string;
  effect: string;
  bonus: number;
}

export interface Snapshot {
  mode: GameMode;
  prompt: string;
  profile: {
    cash: number;
    xp: number;
    rank: string;
    nextRank: { name: string; xp: number } | null;
    contractsDone: number;
    tutorialDone: boolean;
    campaignComplete: boolean;
    upgrades: Record<string, number>;
    equipped: ModuleId | null;
  };
  settings: Settings;
  suggest: string;
  /** A recoverable run parked at home (resume / abandon). */
  pending: null | { label: string; trace: number };
  mission: null | {
    isTutorial: boolean;
    mode: MissionMode;
    practice: boolean;
    index: number;
    name: string;
    codename: string;
    /** Decorative label for the banner — NOT replay data. */
    seed: string;
    code: string;
    trace: number;
    traceExact: number;
    peakTrace: number;
    traceRate: number;
    traceSource: string;
    cleanExitUnder: number;
    cleanExitAvailable: boolean;
    phase: 'quiet' | 'watchdog' | 'alert';
    tools: { proxy: number; decoy: number };
    decoyActive: boolean;
    nodes: NodeView[];
    edges: [string, string][];
    currentNodeId: string;
    watchdogNodeId: string | null;
    targets: TargetView[];
    objective: ObjectiveSnapshot;
    modifier: ModifierSnapshot | null;
    loadoutLabel: string;
    stolen: number;
    required: number;
    sessionCash: number;
    sessionXp: number;
    logsLeft: number;
    optionalLoot: number;
    puzzle: PuzzleSnapshot | null;
    transfer: TransferSnapshot | null;
    transferLabel: string | null;
    elapsed: number;
    /** The bust sequence is playing: any key skips it (the result is already settled). */
    cutscene: boolean;
  };
  lastResult: MissionResult | null;
}

export interface Settings {
  volume: number;
  muted: boolean;
  crt: boolean;
  /** User motion preference; UI also honors prefers-reduced-motion. */
  motion: boolean;
  /** Typewriter output; off prints every line instantly. */
  typing: boolean;
  /** Next-move suggestions (TAB fills them) outside the tutorial. */
  assist: boolean;
}

/** Outcome counters per bucket (contract, objective type). */
export interface OutcomeCounts {
  started: number;
  completed: number;
  early: number;
  busted: number;
}

/** Aggregate, observation-only counters for the PRD §17 tuning loop.
 *  Nothing here influences game outcomes, determinism, or the mission RNG.
 *  Tutorial runs never count. */
export interface Telemetry {
  runsStarted: number;
  runsEnded: number;
  runsCompleted: number;
  runsBusted: number;
  /** Ended early: disconnected without completing the objective. */
  runsShort: number;
  locksEncountered: number;
  locksSolved: number;
  locksSkipped: number;
  lockFailures: number;
  hintsBought: number;
  proxiesBurned: number;
  decoysBurned: number;
  firstBreachSum: number;
  firstBreachCount: number;
  finalTraceSum: number;
  finalTraceCount: number;
  sessions: number;
  lastPlayedAt: number;
  /** v2 additions (bounded maps: keys are contract ids / objective types / families). */
  byContract: Record<string, OutcomeCounts>;
  byObjective: Record<string, OutcomeCounts>;
  failuresByFamily: Record<string, number>;
  resumes: number;
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
  byContract: {},
  byObjective: {},
  failuresByFamily: {},
  resumes: 0,
};

export interface Profile {
  cash: number;
  xp: number;
  contractsDone: number;
  tutorialDone: boolean;
  /** owned shop upgrades: id → level */
  upgrades: Record<string, number>;
  telemetry: Telemetry;
  /** The one optional equipment-module slot (chosen at home). */
  equipped: ModuleId | null;
  campaignComplete: boolean;
  endingSeen: boolean;
}

/** Persistence blob, schema v2. v1 blobs are migrated by persistence.ts. */
export interface SaveBlob {
  version: 2;
  profile: Profile;
  settings: Settings;
  history: string[];
  session: SessionSave | null;
  records: RecordsState;
  /** Daily attempts by UTC date (bounded). */
  daily: Record<string, DailyAttempt>;
  /** A parked run that could not be rebuilt; kept until the player abandons it. */
  brokenSession?: { reason: string; label: string; raw: unknown } | null;
}

/** The pre-migration blob, as written by the original MVP. */
export interface SaveBlobV1 {
  version: 1;
  profile: {
    cash: number;
    xp: number;
    contractsDone: number;
    tutorialDone: boolean;
    upgrades?: Record<string, number>;
    telemetry?: Partial<Telemetry>;
  };
  settings: Partial<Settings>;
  history: string[];
  session: LegacySessionV1 | null;
}

export interface LegacySessionV1 {
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
  puzzle:
    | (Pick<PuzzleState, 'family' | 'nodeId' | 'elapsed' | 'attempts' | 'forcedSuccess'> & {
        sequence?: NonNullable<PuzzleState['sequence']>;
        knock?: { ports: number[]; entered: number[]; showLeft: number };
        cipher?: NonNullable<PuzzleState['cipher']>;
      })
    | null;
  transfer: { fileId: string; progress: number } | null;
  progress: {
    sessionCash: number;
    sessionXp: number;
    downloadsCount: number;
    downloadedValue: number;
    logsWiped: number;
  };
}

/** A pending presentation delay, as data (never a closure) so it survives saves. */
export type PendingAction = { type: 'scan' } | { type: 'breach'; nodeId: string };

/** Complete, serializable mission state (schema v2). */
export interface SessionSave {
  v: 2;
  runId: string;
  descriptor: MissionDescriptor;
  draw: { seed: string; relax: number };
  practice: boolean;
  loadout: Loadout;
  trace: number;
  peakTrace: number;
  rngState: number;
  tools: { proxy: number; decoy: number };
  currentNodeId: string;
  cwd: string[];
  breached: string[];
  downloaded: string[];
  /** `nodeId|/abs/path` of every file removed by download or rm. */
  removed: string[];
  payloadPlaced: boolean;
  vaultLooted: boolean;
  scanned: boolean;
  watchdogNodeId: string | null;
  watchdogTimer: number;
  decoyTimer: number;
  elapsed: number;
  firstBreachAt: number | null;
  /** True once the first-breach sample can no longer be taken (legacy resumes). */
  firstBreachKnown: boolean;
  tutorialStep: number;
  fuseHalf: boolean;
  fuseQuarter: boolean;
  /** Trace accounting so far; `complete` false when part of it predates logging. */
  breakdown: { entries: [string, number][]; complete: boolean };
  clueRead: string[];
  puzzle: null | {
    family: PuzzleFamily;
    nodeId: string;
    timeLimit: number;
    elapsed: number;
    attempts: number;
    forcedSuccess: boolean;
    knock?: { entered: number[]; showLeft: number };
    cipherHinted?: boolean;
  };
  transfer: null | { op: 'download' | 'upload'; key: string; progress: number };
  pending: null | { remaining: number; action: PendingAction };
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
  | 'upload'
  | 'idle'
  | 'log-wipe'
  | 'skip'
  | 'proxy-hop'
  | 'scan'
  | 'unrecorded';

export type Config = typeof CONFIG;
