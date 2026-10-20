import { CONFIG } from './config.js';
import { COMMANDS, commandsForMode, didYouMean, lookupCommand, manPage } from './commands.js';
import {
  gradeCipher,
  gradeKnock,
  gradeSequence,
  instantiatePuzzle,
  puzzleHint,
  puzzlePrompt,
  puzzleView,
  type Grade,
} from './puzzles.js';
import { Rng, formatSeed } from './rng.js';
import {
  decoysFor,
  fuseBonusFor,
  hintCostFor,
  idleRateFactor,
  proxyHopsFor,
  shopItem,
  transferSecondsFor,
  upgradeCost,
  upgradeLevel,
} from './shop.js';
import { tutorialMission, TUTORIAL_STEPS } from './tutorial.js';
import { buildValidatedMission } from './validate.js';
import { contractSeed as contractSeedOf, generateMission } from './missions.js';
import { TELEMETRY_DEFAULT } from './types.js';
import type {
  Cls,
  DirSpec,
  EngineEvent,
  FileSpec,
  GameMode,
  MissionResult,
  MissionSpec,
  NodeView,
  PuzzleState,
  SaveBlob,
  SessionSave,
  Snapshot,
  TraceCause,
} from './types.js';
import { Vfs } from './vfs.js';

/**
 * GameEngine — the whole game loop, headless. React is a view layer: it submits
 * command strings, drains events, calls tick(dt) with wall-clock deltas, and reads
 * snapshots for the HUD. No DOM types appear anywhere in this package.
 */

type Phase = 'quiet' | 'watchdog' | 'alert';

interface Transfer {
  nodeId: string;
  dir: DirSpec;
  file: FileSpec;
  path: string;
  progress: number; // 0..1
  nextProgressAt: number;
}

interface Cutscene {
  lines: { delay: number; text: string; cls?: Cls }[];
  timer: number;
  then?: () => void;
}

interface Runtime {
  spec: MissionSpec;
  trace: number;
  /** Active-play seconds since mission start (drives time-to-first-breach). */
  elapsed: number;
  vfs: Map<string, Vfs>;
  cwd: string[];
  currentIdx: number;
  breached: Set<string>;
  scanned: boolean;
  /** `nodeId|/abs/path` for every file removed by download or rm. */
  pulled: Set<string>;
  downloadedTargets: Set<string>;
  downloadsCount: number;
  downloadedValue: number;
  logsWiped: number;
  sessionCash: number;
  sessionXp: number;
  tools: { proxy: number; decoy: number };
  watchdogNodeId: string | null;
  watchdogTimer: number;
  decoyTimer: number;
  puzzle: PuzzleState | null;
  transfer: Transfer | null;
  pending: { remaining: number; then: () => void } | null;
  phase: Phase;
  breakdown: Map<string, number>;
  fuseHalf: boolean;
  fuseQuarter: boolean;
  cutscene: Cutscene | null;
  ended: boolean;
  tutorialStep: number;
  firstBreachAt: number | null;
  rng: Rng;
}

export interface StorageAdapter {
  load(): SaveBlob | null;
  save(blob: SaveBlob): void;
}

export interface GameEngineOptions {
  storage?: StorageAdapter;
  /** Start from this save (profile + optional recoverable session). */
  save?: SaveBlob | null;
  /** Test hook: zero out action delays so headless tests tick only what they care about. */
  fast?: boolean;
  /** Test hook: injectable clock for telemetry session bookkeeping. */
  now?: () => number;
}

const DEFAULT_SAVE: SaveBlob = {
  version: 1,
  profile: {
    cash: 0,
    xp: 0,
    contractsDone: 0,
    tutorialDone: false,
    upgrades: {},
    telemetry: { ...TELEMETRY_DEFAULT },
  },
  settings: { volume: 0.8, muted: false, crt: true, motion: true },
  history: [],
  session: null,
};

export class GameEngine {
  mode: GameMode = 'boot';
  profile: SaveBlob['profile'];
  settings: SaveBlob['settings'];
  history: string[] = [];
  lastResult: MissionResult | null = null;
  suggest = '';

  private storage: StorageAdapter | undefined;
  private fast: boolean;
  private now: () => number;
  private rt: Runtime | null = null;
  private pendingSession: SessionSave | null = null;
  private boot: Cutscene | null = null;
  /**
   * The engine's single output channel. Delayed actions (breach spin-up, scan
   * sweep) push events here long after the original submit() returned — if
   * helpers pushed into a caller's local array, everything delayed would
   * silently vanish from the UI (player-reported: locks opened with no prompt
   * on screen). submit()/tick() drain this and return everything queued.
   */
  private outbox: EngineEvent[] = [];
  private static specCache = new Map<string, MissionSpec>();

  constructor(opts: GameEngineOptions = {}) {
    this.storage = opts.storage;
    this.fast = opts.fast ?? false;
    this.now = opts.now ?? (() => Date.now());
    const save = opts.save ?? this.storage?.load() ?? null;
    this.profile = {
      ...DEFAULT_SAVE.profile,
      ...save?.profile,
      // nested defaults so pre-shop / pre-telemetry saves migrate cleanly
      upgrades: { ...save?.profile?.upgrades },
      telemetry: { ...TELEMETRY_DEFAULT, ...save?.profile?.telemetry },
    };
    this.settings = { ...DEFAULT_SAVE.settings, ...save?.settings };
    this.history = (save?.history ?? []).slice(-100);
    this.pendingSession = save?.session ?? null;
    this.startBoot();
  }

  /* =============================== public API =============================== */

  /** Submit a command line; returns the events it produced (including any that
   *  fired from delayed actions this call started). */
  submit(line: string): EngineEvent[] {
    const ev = this.outbox;
    const raw = line.trim();
    if (this.mode === 'boot') {
      this.skipBoot(ev);
      return this.drainOutbox();
    }
    if (raw) {
      if (this.history[this.history.length - 1] !== raw) this.history.push(raw);
      if (this.history.length > 100) this.history.shift();
    }
    if (!raw) return this.drainOutbox();
    if (this.mode === 'post') {
      this.dispatchPost(raw, ev);
    } else if (this.mode === 'home') {
      this.dispatchHome(raw, ev);
    } else if (this.rt?.cutscene) {
      ev.push(print('the grid is talking. hold.', 'warn'));
    } else {
      this.dispatchMission(raw, ev);
    }
    return this.drainOutbox();
  }

  private drainOutbox(): EngineEvent[] {
    return this.outbox.splice(0);
  }

  /** Advance time (seconds). UI drives this from its frame loop; tests call it directly. */
  tick(dtSec: number): EngineEvent[] {
    const ev = this.outbox;
    const dt = Math.min(Math.max(dtSec, 0), 1);
    if (this.mode === 'boot' && this.boot) {
      this.runCutscene(this.boot, dt, ev);
      if (!this.boot.lines.length && !this.boot.then) {
        this.boot = null;
        this.finishBoot(ev);
      }
      return this.drainOutbox();
    }
    const rt = this.rt;
    if (!rt || rt.ended) return this.drainOutbox();
    rt.elapsed += dt;
    if (rt.cutscene) {
      this.runCutscene(rt.cutscene, dt, ev);
      return this.drainOutbox();
    }
    if (rt.pending) {
      rt.pending.remaining -= dt;
      if (rt.pending.remaining <= 0) {
        const then = rt.pending.then;
        rt.pending = null;
        then();
      }
    }
    if (rt.transfer) {
      this.tickTransfer(rt, dt, ev);
    } else if (!rt.pending) {
      // Baseline creep on a foreign network (PRD §7), doubled under admin alert,
      // softened by the ghost route upgrade.
      const rate =
        CONFIG.trace.idlePerSecond *
        (rt.phase === 'alert' ? CONFIG.trace.alertCreepMultiplier : 1) *
        idleRateFactor(this.profile);
      if (rate > 0) this.addTrace(rt, rate * dt, 'idle', ev);
    }
    if (rt.puzzle) {
      this.tickPuzzle(rt, dt, ev);
    }
    if (rt.watchdogNodeId && rt.decoyTimer <= 0) {
      rt.watchdogTimer -= dt;
      if (rt.watchdogTimer <= 0) {
        rt.watchdogTimer = CONFIG.tools.watchdogMoveSeconds;
        this.moveWatchdog(rt, ev);
      }
    }
    if (rt.decoyTimer > 0) {
      const before = rt.decoyTimer;
      rt.decoyTimer = Math.max(0, rt.decoyTimer - dt);
      if (before > 0 && rt.decoyTimer === 0 && rt.watchdogNodeId) {
        ev.push(print('[-] decoy spent — the watchdog is back on your chain.', 'warn'));
        ev.push({ t: 'state' });
      }
    }
    return this.drainOutbox();
  }

  getState(): Snapshot {
    const rt = this.rt;
    const rank = rankFor(this.profile.xp);
    const snap: Snapshot = {
      mode: this.mode,
      prompt: this.prompt(),
      profile: {
        cash: Math.round(this.profile.cash),
        xp: Math.round(this.profile.xp),
        rank: rank.name,
        contractsDone: this.profile.contractsDone,
        tutorialDone: this.profile.tutorialDone,
        upgrades: { ...this.profile.upgrades },
      },
      settings: { ...this.settings },
      suggest: this.suggest,
      mission: null,
      lastResult: this.lastResult,
    };
    if (rt && (this.mode === 'mission' || this.mode === 'post')) {
      snap.mission = {
        isTutorial: rt.spec.kind === 'tutorial',
        index: rt.spec.index,
        name: rt.spec.name,
        codename: rt.spec.codename,
        seed: formatSeed(rt.spec.seed),
        trace: Math.round(rt.trace),
        phase: rt.phase,
        tools: { ...rt.tools },
        nodes: rt.spec.nodes.map((n, i) => this.nodeView(rt, n, i)),
        currentNodeId: rt.spec.nodes[rt.currentIdx]!.id,
        watchdogNodeId: rt.watchdogNodeId,
        targets: rt.spec.nodes.flatMap((n) =>
          walkFiles(n.root)
            .filter((f) => f.tag === 'target' && f.targetId)
            .map((f) => ({
              id: f.targetId!,
              name: f.name,
              nodeId: n.id,
              stolen: rt.downloadedTargets.has(f.targetId!),
            }))
        ),
        stolen: rt.downloadedTargets.size,
        required: rt.spec.requiredTargets,
        sessionCash: Math.round(rt.sessionCash),
        sessionXp: Math.round(rt.sessionXp),
        logsLeft: countLogs(rt),
        puzzle: rt.puzzle
          ? {
              family: rt.puzzle.family,
              nodeId: rt.puzzle.nodeId,
              prompt: puzzlePrompt(rt.puzzle),
              timeLeft: Math.max(0, rt.puzzle.timeLimit - rt.puzzle.elapsed),
              timeLimit: rt.puzzle.timeLimit,
              attempts: rt.puzzle.attempts,
              knockPortsVisible:
                rt.puzzle.family === 'portknock' ? rt.puzzle.knock!.showLeft > 0 : false,
              knockPorts:
                rt.puzzle.family === 'portknock' && rt.puzzle.knock!.showLeft > 0
                  ? [...rt.puzzle.knock!.ports]
                  : [],
              cipherText:
                rt.puzzle.family === 'cipher' ? puzzleView(rt.puzzle).cipherText ?? '' : '',
            }
          : null,
        transferLabel: rt.transfer ? rt.transfer.file.name : null,
      };
    }
    return snap;
  }

  /** TAB completion candidates for the current input state. */
  complete(input: string): { items: string[]; from: number } {
    if (this.mode === 'boot') return { items: [], from: 0 };
    const endsWithSpace = /\s$/.test(input);
    const tokens = input.split(/\s+/);
    const verb = tokens[0]!.toLowerCase();
    if (tokens.length <= 1 && !endsWithSpace) {
      const items = commandsForMode(this.mode === 'post' ? 'home' : this.mode)
        .map((c) => c.name)
        .filter((n) => n.startsWith(verb))
        .sort();
      return { items, from: 0 };
    }
    const rt = this.rt;
    if (this.mode === 'mission' && rt) {
      if (['cat', 'cd', 'ls', 'rm', 'download'].includes(verb)) {
        return this.completePath(rt, input, tokens);
      }
      if (verb === 'connect' || verb === 'breach') {
        const prefix = (tokens[tokens.length - 1] ?? '').toLowerCase();
        const from = input.length - prefix.length;
        const items: string[] = [];
        if (rt.scanned) {
          rt.spec.nodes.forEach((n, i) => {
            const matches =
              n.ip.startsWith(prefix) || n.hostname.toLowerCase().startsWith(prefix);
            if (!matches) return;
            const owned = i === 0 || rt.breached.has(n.id);
            if (verb === 'connect' && owned && i !== rt.currentIdx) items.push(n.ip);
            if (verb === 'breach' && !owned && Math.abs(i - rt.currentIdx) === 1) items.push(n.ip);
          });
        }
        return { items, from };
      }
      if (verb === 'man' || verb === 'help') {
        const prefix = (tokens[tokens.length - 1] ?? '').toLowerCase();
        return {
          items: COMMANDS.map((c) => c.name).filter((n) => n.startsWith(prefix)),
          from: input.length - prefix.length,
        };
      }
    }
    return { items: [], from: 0 };
  }

  serialize(): SaveBlob {
    return {
      version: 1,
      profile: { ...this.profile },
      settings: { ...this.settings },
      history: this.history.slice(-100),
      session:
        this.rt && this.mode === 'mission' && !this.rt.ended && !this.rt.cutscene
          ? this.snapshotSession(this.rt)
          : null,
    };
  }

  persist(): void {
    this.storage?.save(this.serialize());
  }

  /** Bypasses the home screen — used by `run`, tests, and the validator. */
  startMission(spec: MissionSpec, ev: EngineEvent[]): void {
    const rng = new Rng(`${spec.seed}::runtime`);
    const vfs = new Map<string, Vfs>();
    for (const n of spec.nodes) vfs.set(n.id, new Vfs(cloneSpecTree(n.root)));
    const rt: Runtime = {
      spec,
      trace: 0,
      elapsed: 0,
      vfs,
      cwd: [],
      currentIdx: 0,
      breached: new Set(['n0']),
      scanned: false,
      pulled: new Set(),
      downloadedTargets: new Set(),
      downloadsCount: 0,
      downloadedValue: 0,
      logsWiped: 0,
      sessionCash: 0,
      sessionXp: 0,
      tools: {
        proxy: proxyHopsFor(this.profile),
        decoy: decoysFor(this.profile),
      },
      watchdogNodeId: null,
      watchdogTimer: CONFIG.tools.watchdogMoveSeconds,
      decoyTimer: 0,
      puzzle: null,
      transfer: null,
      pending: null,
      phase: 'quiet',
      breakdown: new Map(),
      fuseHalf: false,
      fuseQuarter: false,
      cutscene: null,
      ended: false,
      tutorialStep: 0,
      firstBreachAt: null,
      rng,
    };
    this.rt = rt;
    this.mode = 'mission';
    this.lastResult = null;
    if (spec.kind === 'contract') this.profile.telemetry.runsStarted++;

    ev.push({ t: 'clear' });
    this.setSuggest(ev, '');
    ev.push(print(missionBanner(spec), 'banner', 'instant'));
    ev.push(
      print(
        `objective: steal ${spec.requiredTargets} flagged file${spec.requiredTargets === 1 ? '' : 's'} · seed ${formatSeed(spec.seed)}`,
        'dim'
      )
    );
    ev.push(print(spec.brief, 'info'));
    ev.push({ t: 'handler', text: spec.handlerLines[0]! });
    if (spec.handlerLines[1]) ev.push({ t: 'handler', text: spec.handlerLines[1] });
    ev.push(
      print(
        `\nconnected: ${spec.nodes[0]!.hostname} (${spec.nodes[0]!.ip}) — your foothold. type \`scan\`.`,
        'sys'
      )
    );
    if (spec.kind === 'tutorial') {
      const first = TUTORIAL_STEPS[0]!;
      this.setSuggest(ev, first.cmd.join(' '));
      ev.push({ t: 'handler', text: `Next: \`${first.cmd.join(' ')}\` — ${first.note}. TAB fills it.` });
    }
    ev.push({ t: 'sfx', name: 'connect' });
    ev.push({ t: 'state' });
  }

  /* ============================== boot & home =============================== */

  private startBoot(): void {
    this.mode = 'boot';
    this.boot = {
      lines: [
        { delay: 0.45, text: 'CYBERGRID BIOS v4.11 — burner build', cls: 'dim' },
        { delay: 0.35, text: 'mem check ................ 64K OK', cls: 'dim' },
        { delay: 0.3, text: 'route spoof .............. armed', cls: 'dim' },
        { delay: 0.3, text: 'mac pool ................. 11 ghosts', cls: 'dim' },
        { delay: 0.55, text: 'handshake: broker node ▓▓▓▓▓▓▓▓ established', cls: 'sys' },
        { delay: 0.45, text: "[+] tunnel hot. you're in.", cls: 'good' },
      ],
      timer: 0.45,
    };
  }

  private skipBoot(ev: EngineEvent[]): void {
    if (this.boot) {
      for (const line of this.boot.lines) ev.push(print(line.text, line.cls ?? 'info', 'instant'));
      this.boot = null;
    }
    this.finishBoot(ev);
    ev.push(print('(boot sequence skipped)', 'dim'));
  }

  private finishBoot(ev: EngineEvent[]): void {
    this.mode = 'home';
    ev.push({ t: 'clear' });
    ev.push(print(homeBanner(), 'banner', 'instant'));
    ev.push(print('trace is time. time is trace. type `help` for verbs, `contracts` for work.', 'dim'));
    if (this.pendingSession) {
      ev.push(print('[!] recoverable session found — a run was live when the terminal died.', 'warn'));
      ev.push(print('    `resume` to get back on the wire · `abandon` to drop it.', 'warn'));
    }
    if (!this.profile.tutorialDone) {
      ev.push({ t: 'handler', text: "First job is a warm-up. I'll walk you through it — type `tutorial`." });
      this.setSuggest(ev, 'tutorial');
    } else {
      ev.push({ t: 'handler', text: "Back again. Board's live — `contracts`." });
      this.setSuggest(ev, 'contracts');
    }
    ev.push({ t: 'state' });
  }

  private runCutscene(cs: Cutscene, dt: number, ev: EngineEvent[]): void {
    cs.timer -= dt;
    if (cs.timer > 0) return;
    const next = cs.lines.shift();
    if (next) {
      ev.push(print(next.text, next.cls ?? 'info', 'instant'));
      cs.timer = next.delay;
    } else {
      const then = cs.then;
      then?.();
    }
  }

  private dispatchHome(raw: string, ev: EngineEvent[]): void {
    const [verb, ...args] = raw.split(/\s+/);
    const v = verb!.toLowerCase();
    switch (v) {
      case 'help':
      case '?':
      case 'verbs':
        this.printHelp(ev, 'home');
        break;
      case 'man':
        this.printMan(args, ev);
        break;
      case 'clear':
      case 'cls':
        ev.push({ t: 'clear' });
        break;
      case 'contracts':
      case 'jobs':
      case 'missions':
        this.printContracts(ev);
        break;
      case 'run':
        this.cmdRun(args, ev);
        break;
      case 'tutorial':
        this.startMission(tutorialMission(), ev);
        break;
      case 'profile':
      case 'status':
      case 'whoami':
        this.printProfile(ev);
        break;
      case 'shop':
      case 'market':
        this.printShop(ev);
        break;
      case 'buy':
        this.cmdBuy(args, ev);
        break;
      case 'stats':
      case 'analytics':
        this.printStats(ev);
        break;
      case 'settings':
      case 'config':
        this.cmdSettings(args, ev);
        break;
      case 'resume':
        this.cmdResume(ev);
        break;
      case 'abandon':
        if (this.pendingSession) {
          this.pendingSession = null;
          this.persist();
          ev.push(print('[-] session dropped. nothing scored.', 'warn'));
        } else {
          ev.push(print('nothing to abandon.', 'dim'));
        }
        break;
      case 'wipe':
      case 'reset':
        if (args[0]?.toLowerCase() === 'confirm') {
          this.profile = {
            cash: 0,
            xp: 0,
            contractsDone: 0,
            tutorialDone: false,
            upgrades: {},
            telemetry: { ...TELEMETRY_DEFAULT },
          };
          this.history = [];
          this.pendingSession = null;
          this.lastResult = null;
          this.persist();
          ev.push({ t: 'clear' });
          ev.push(print('[-] burner wiped. day zero. type `tutorial`.', 'warn'));
          this.setSuggest(ev, 'tutorial');
        } else {
          ev.push(print('[!] this erases ALL progression. `wipe confirm` to do it.', 'warn'));
        }
        break;
      case 'about':
      case 'cybergrid':
        ev.push(print('CyberGrid — a tension game disguised as a terminal.', 'accent'));
        ev.push(print('steal the files, watch the meter, be somewhere else before 100%.', 'dim'));
        break;
      case 'skipintro':
        ev.push(print('already home. `contracts` for the board.', 'dim'));
        break;
      default: {
        const guess = didYouMean(v, 'home');
        if (guess) ev.push(print(`[-] unknown verb: '${v}'. did you mean '${guess}'?`, 'bad'));
        else ev.push(print(`[-] unknown verb: '${v}'. type \`help\`.`, 'bad'));
        ev.push({ t: 'sfx', name: 'err' });
      }
    }
    ev.push({ t: 'state' });
  }

  private dispatchPost(raw: string, ev: EngineEvent[]): void {
    const [verb, ...args] = raw.split(/\s+/);
    const v = verb!.toLowerCase();
    switch (v) {
      case 'retry':
      case 'again':
        this.cmdRetry(ev);
        break;
      case 'run':
        // the post screen may suggest `run <n>` — it must work from here too
        this.cmdRun(args, ev);
        break;
      case 'tutorial':
        this.startMission(tutorialMission(), ev);
        break;
      case 'home':
      case 'contracts':
      case 'jobs':
      case 'missions':
        this.mode = 'home';
        ev.push({ t: 'clear' });
        this.printContracts(ev);
        break;
      case 'help':
      case '?':
        this.printHelp(ev, 'home');
        break;
      case 'man':
        this.printMan(args, ev);
        break;
      case 'profile':
        this.printProfile(ev);
        break;
      case 'stats':
        this.printStats(ev);
        break;
      case 'settings':
        this.cmdSettings(args, ev);
        break;
      case 'clear':
        ev.push({ t: 'clear' });
        break;
      default:
        ev.push(print('[ENTER] retry the same seed · `contracts` for the board', 'dim'));
    }
    ev.push({ t: 'state' });
  }

  /* ============================== mission cmds ============================== */

  private dispatchMission(raw: string, ev: EngineEvent[]): void {
    const rt = this.rt!;
    const tokens = raw.split(/\s+/);
    const verb = tokens[0]!.toLowerCase();
    const args = tokens.slice(1);

    if (!this.tutorialGate(rt, verb, args, ev)) return;

    // While a lock is open, the lock owns the terminal.
    if (rt.puzzle) {
      const lockVerbs = [
        'input', 'answer', 'decode', 'knock', 'skip', 'bypass', 'hint',
        'disconnect', 'exit', 'quit', 'logout', 'escape', 'help', '?', 'man', 'clear', 'cls',
      ];
      const bareAnswer = !lookupCommand(verb) && /^[\dA-Za-z]+$/.test(verb);
      if (bareAnswer && !lockVerbs.includes(verb)) {
        this.puzzleAnswer(rt, verb, args.length ? args.join(' ') : verb, ev);
        return;
      }
      if (verb === 'skip' || verb === 'bypass') return this.puzzleSkip(rt, ev);
      if (verb === 'hint') return this.puzzleHintCmd(rt, ev);
      if (verb === 'input' || verb === 'answer' || verb === 'decode') {
        return this.puzzleAnswer(rt, verb, args.join(' '), ev);
      }
      if (verb === 'knock') return this.puzzleKnock(rt, args, ev);
      if (!lockVerbs.includes(verb)) {
        ev.push(print('[!] a lock is open — `input <answer>` / `knock <ports>`, or `skip` / `hint`.', 'warn'));
        return;
      }
      // disconnect/help/man/clear fall through to normal dispatch below.
    } else if (!lookupCommand(verb) && /^\d+$/.test(verb)) {
      ev.push(print('[-] nothing to answer. breach something first.', 'bad'));
      return;
    }

    switch (verb) {
      case 'scan':
      case 'sc':
      case 'recon':
        this.cmdScan(rt, ev);
        break;
      case 'connect':
      case 'ssh':
      case 'hop':
        this.cmdConnect(rt, args, ev);
        break;
      case 'breach':
      case 'exploit':
        this.cmdBreach(rt, args, ev);
        break;
      case 'ls':
      case 'dir':
        this.cmdLs(rt, args, ev);
        break;
      case 'cd':
        this.cmdCd(rt, args, ev);
        break;
      case 'cat':
      case 'read':
        this.cmdCat(rt, args, ev);
        break;
      case 'download':
      case 'dl':
      case 'scp':
      case 'get':
      case 'exfil':
        this.cmdDownload(rt, args, ev);
        break;
      case 'rm':
      case 'del':
      case 'shred':
        this.cmdRm(rt, args, ev);
        break;
      case 'disconnect':
      case 'exit':
      case 'quit':
      case 'logout':
      case 'escape':
        this.tutorialAdvance(rt, 'disconnect', ev);
        this.cmdDisconnect(rt, ev);
        break;
      case 'proxy':
      case 'proxyhop':
      case 'proxy-hop':
        this.cmdProxy(rt, ev);
        break;
      case 'decoy':
        this.cmdDecoy(rt, ev);
        break;
      case 'input':
      case 'answer':
      case 'decode':
      case 'knock':
        ev.push(print('[-] no lock open. `breach <ip>` to pick one.', 'bad'));
        break;
      case 'skip':
      case 'bypass':
        ev.push(print('[-] nothing to skip. locks only.', 'bad'));
        break;
      case 'hint':
        ev.push(print('[-] hints are for locks. no lock, no fee.', 'bad'));
        break;
      case 'wipe':
        ev.push(print('[-] `wipe` is a home-terminal verb. (rm is the in-job one.)', 'dim'));
        break;
      case 'help':
      case '?':
        this.printHelp(ev, 'mission');
        break;
      case 'man':
        this.printMan(args, ev);
        break;
      case 'clear':
      case 'cls':
        ev.push({ t: 'clear' });
        break;
      case 'profile':
        this.printProfile(ev);
        break;
      case 'stats':
        this.printStats(ev);
        break;
      case 'shop':
      case 'market':
      case 'buy':
        ev.push(print('[-] the market is at home. `disconnect` first — no shopping mid-heist.', 'warn'));
        break;
      case 'skipintro':
        this.cmdSkipIntro(rt, ev);
        break;
      case 'contracts':
      case 'run':
      case 'tutorial':
      case 'resume':
      case 'abandon':
        ev.push(print('[-] mid-run. `disconnect` first — the Broker frowns on leaving mid-job.', 'warn'));
        break;
      default: {
        const guess = didYouMean(verb, 'mission');
        if (guess) ev.push(print(`[-] unknown verb: '${verb}'. did you mean '${guess}'?`, 'bad'));
        else ev.push(print(`[-] unknown verb: '${verb}'. type \`help\`.`, 'bad'));
        ev.push({ t: 'sfx', name: 'err' });
      }
    }
    ev.push({ t: 'state' });
  }

  /* ------------------------------- scan etc. ------------------------------- */

  private cmdScan(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.pending) {
      ev.push(print('[…] sweep already running.', 'dim'));
      return;
    }
    ev.push(print('[…] sweeping the chain…', 'dim'));
    this.later(rt, this.fast ? 0 : 1.1, () => {
      rt.scanned = true;
      ev.push(print('[+] network mapped — see the HUD board (left).', 'good'));
      rt.spec.nodes.forEach((n, i) => {
        const status =
          i === 0
            ? 'foothold'
            : rt.breached.has(n.id)
              ? 'owned'
              : Math.abs(i - rt.currentIdx) === 1
                ? 'reachable'
                : 'chained';
        const targetNote =
          i === 0 ? '' : ` · flagged: ${countTargets(n.root, rt.downloadedTargets)}`;
        const loot = sumLoot(n.root);
        ev.push(
          print(
            `  ${n.ip.padEnd(12)} ${n.hostname.padEnd(14)} sec ${n.security}  loot ~$${loot}${targetNote}  [${status}]`,
            i === 0 ? 'dim' : status === 'reachable' ? 'accent' : 'info'
          )
        );
      });
      ev.push(print('deeper nodes pay more and burn more trace. the route is your call.', 'dim'));
      ev.push({ t: 'sfx', name: 'ok' });
      ev.push({ t: 'state' });
      this.tutorialAdvance(rt, 'scan', ev);
    });
  }

  private cmdConnect(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    const target = this.resolveNode(rt, args.join(' '));
    if (!target) {
      ev.push(print(`[-] no node '${args.join(' ')}' on this chain. \`scan\` first?`, 'bad'));
      return;
    }
    const idx = rt.spec.nodes.indexOf(target);
    if (idx === rt.currentIdx) {
      ev.push(print('[-] already on it.', 'dim'));
      return;
    }
    if (idx !== 0 && !rt.breached.has(target.id)) {
      ev.push(print(`[-] ${target.ip} is still locked. \`breach ${target.ip}\` first.`, 'bad'));
      return;
    }
    rt.currentIdx = idx;
    rt.cwd = [];
    this.addTrace(rt, CONFIG.trace.connectHop, 'connect', ev);
    ev.push(
      print(`[+] session moved to ${target.hostname} (${target.ip}). trace +${CONFIG.trace.connectHop}`, 'good')
    );
    ev.push({ t: 'sfx', name: 'connect' });
  }

  private cmdBreach(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    if (rt.pending) {
      ev.push(print('[…] something is already running — hold.', 'dim'));
      return;
    }
    if (!args.length) {
      // No target given: hand the player the reachable list instead of a shrug.
      const reachable = rt.spec.nodes.filter(
        (n, i) => i !== 0 && !rt.breached.has(n.id) && Math.abs(i - rt.currentIdx) === 1
      );
      if (!reachable.length) {
        ev.push(print('[-] nothing adjacent to breach — `connect <ip>` deeper into your owned chain.', 'warn'));
        return;
      }
      ev.push(print('[?] breach which node? from here you can reach:', 'warn'));
      for (const n of reachable) {
        ev.push(print(`    breach ${n.ip}   (${n.hostname}${rt.scanned ? `, sec ${n.security}` : ''})`, 'accent'));
      }
      this.setSuggest(ev, `breach ${reachable[0]!.ip}`);
      return;
    }
    const target = this.resolveNode(rt, args.join(' '));
    if (!target) {
      ev.push(print(`[-] no node '${args.join(' ')}' on this chain. \`scan\` lists the ips — hostnames work too.`, 'bad'));
      return;
    }
    const idx = rt.spec.nodes.indexOf(target);
    if (idx === 0 || rt.breached.has(target.id)) {
      ev.push(print('[-] already owned. `connect <ip>` to hop there.', 'dim'));
      return;
    }
    if (Math.abs(idx - rt.currentIdx) !== 1) {
      ev.push(print('[-] no direct route — the chain only opens from a neighboring node.', 'bad'));
      return;
    }
    if (rt.puzzle) {
      ev.push(print('[!] a lock is already cycling on your terminal.', 'warn'));
      return;
    }
    if (rt.transfer) {
      ev.push(print('[!] transfer in flight — hang on or disconnect.', 'warn'));
      return;
    }
    ev.push(print(`[!] breaching ${target.hostname} (${target.ip})…`, 'warn'));
    ev.push({ t: 'sfx', name: 'breachStart' });
    // The old suggestion is about to be wrong — drop it so TAB can't refill
    // `breach <ip>` while the lock is still spinning up.
    this.setSuggest(ev, '');
    this.later(rt, this.fast ? 0 : 0.9, () => {
      if (rt.ended) return;
      const sec = target.security as 1 | 2 | 3;
      const timeLimit = CONFIG.puzzle.timeBoxBySecurity[sec]! + fuseBonusFor(this.profile);
      rt.puzzle = instantiatePuzzle(
        rt.spec.puzzleAnswers[target.id]!,
        target.id,
        sec,
        timeLimit,
        rt.spec.kind === 'tutorial'
      );
      rt.fuseHalf = false;
      rt.fuseQuarter = false;
      if (rt.spec.kind === 'contract') this.profile.telemetry.locksEncountered++;
      ev.push(print(`[!] firewall lock engaged — fuse ${timeLimit}s:`, 'warn'));
      ev.push(print('    ' + puzzlePrompt(rt.puzzle), 'accent', 'instant'));
      if (rt.puzzle.family === 'sequence') {
        ev.push(print('    (the four terms follow one rule — `input <the next number>` · `man breach` has every rule)', 'dim'));
      } else if (rt.puzzle.family === 'portknock') {
        ev.push(print('    (watch the glow — then `knock <p1> <p2> ...` from memory)', 'dim'));
      } else {
        ev.push(print('    (a Caesar plaque — `input <decoded word>`; check plaque.txt on the node)', 'dim'));
      }
      ev.push({ t: 'puzzleOpen', puzzle: puzzleView(rt.puzzle) });
      ev.push({ t: 'state' });
      this.tutorialAdvance(rt, 'breach', ev);
    });
  }

  /* --------------------------------- VFS ---------------------------------- */

  private cmdLs(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    const path = args.length ? args.join(' ') : '.';
    const listing = this.currentVfs(rt).list(path, rt.cwd);
    if (!listing) {
      ev.push(print(`[-] no such directory: ${path}`, 'bad'));
      return;
    }
    if (listing.dirs.length === 0 && listing.files.length === 0) {
      ev.push(print('(empty)', 'dim'));
      return;
    }
    for (const d of listing.dirs) {
      ev.push(print(`  ${pad(d + '/', 26)}<dir>`, 'accent'));
    }
    for (const f of listing.files) {
      const note =
        f.tag === 'target'
          ? `LOOT $${f.value} · TARGET`
          : f.tag === 'loot'
            ? `LOOT $${f.value}`
            : f.tag === 'log'
              ? 'LOG — rm buys trace margin'
              : '';
      const cls: Cls = f.tag === 'target' || f.tag === 'loot' ? 'loot' : f.tag === 'log' ? 'log' : 'dim';
      ev.push(print(`  ${pad(f.name, 26)}${note}`, cls));
    }
    this.tutorialAdvance(rt, 'ls', ev);
  }

  private cmdCd(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    const path = args.join(' ');
    if (!path) {
      ev.push(print('/' + rt.cwd.join('/'), 'dim'));
      return;
    }
    const dir = this.currentVfs(rt).resolveDir(path, rt.cwd);
    if (!dir) {
      ev.push(print(`[-] no such directory: ${path}`, 'bad'));
      return;
    }
    const parts = path.startsWith('/') ? Vfs.splitPath(path) : [...rt.cwd, ...Vfs.splitPath(path)];
    rt.cwd = normalizeParts(parts);
    ev.push(print(`cwd: /${rt.cwd.join('/')}`, 'sys'));
    this.tutorialAdvance(rt, 'cd', ev);
  }

  private cmdCat(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    if (!args.length) {
      ev.push(print('[-] cat what?', 'bad'));
      return;
    }
    const hit = this.currentVfs(rt).resolveFile(args.join(' '), rt.cwd);
    if (!hit) {
      const elsewhere = locateFileOnNode(this.currentVfs(rt).rootDir, args.join(' '));
      if (elsewhere) {
        ev.push(print(`[-] not in this directory — it's at ${elsewhere}.`, 'warn'));
      } else {
        const guess = suggestFile(this.currentVfs(rt), rt.cwd, args.join(' '));
        ev.push(
          print(`[-] no such file: ${args.join(' ')}${guess ? ` — did you mean '${guess}'?` : ''}`, 'bad')
        );
      }
      return;
    }
    const f = hit.file;
    if (f.tag === 'loot' || f.tag === 'target') {
      ev.push(
        print(
          `[##] ${f.name}: binary blob, encrypted payload ($${f.value}${f.tag === 'target' ? ' · TARGET' : ''}).`,
          'loot'
        )
      );
      ev.push(print('     it only matters once it is on your rig — `download` it.', 'dim'));
      return;
    }
    for (const line of (f.content ?? '(corrupted — nothing readable)').split('\n')) {
      ev.push(print('  ' + line, f.tag === 'log' ? 'log' : 'info'));
    }
    if (f.tag === 'log') ev.push(print('  (this log is hot — `rm` it to clear trace)', 'warn'));
  }

  private cmdDownload(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    if (rt.transfer) {
      ev.push(print('[!] transfer already running — hold.', 'warn'));
      return;
    }
    if (rt.pending) {
      ev.push(print('[…] something is already running — hold.', 'dim'));
      return;
    }
    if (!args.length) {
      ev.push(print('[-] download what? `ls` to see loot.', 'bad'));
      return;
    }
    const path = args.join(' ').replace(/\s+(local|to|->|→)\s*.*$/i, ''); // tolerate `scp x local`
    const hit = this.currentVfs(rt).resolveFile(path, rt.cwd);
    if (!hit) {
      const elsewhere = locateFileOnNode(this.currentVfs(rt).rootDir, path.split('/').pop() ?? path);
      if (elsewhere) {
        ev.push(print(`[-] not in this directory — it's at ${elsewhere}.`, 'warn'));
        ev.push(print('    `cd` over or download the full path.', 'dim'));
      } else {
        const guess = suggestFile(this.currentVfs(rt), rt.cwd, path);
        ev.push(print(`[-] no such file: ${path}${guess ? ` — did you mean '${guess}'?` : ''}`, 'bad'));
      }
      return;
    }
    if (hit.file.tag !== 'loot' && hit.file.tag !== 'target') {
      ev.push(print('[-] nothing worth the noise. loot files only.', 'bad'));
      return;
    }
    rt.transfer = {
      nodeId: rt.spec.nodes[rt.currentIdx]!.id,
      dir: hit.dir,
      file: hit.file,
      path: absPathOf(rt.cwd, path, hit.file.name),
      progress: 0,
      nextProgressAt: 0.05,
    };
    ev.push(
      print(
        `[»] transferring ${hit.file.name} ($${hit.file.value}${hit.file.tag === 'target' ? ' · TARGET' : ''}) — trace +5/s while it runs`,
        'loot'
      )
    );
    ev.push({ t: 'sfx', name: 'breachStart' });
  }

  private cmdRm(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    if (!args.length) {
      ev.push(print('[-] rm what?', 'bad'));
      return;
    }
    const path = args.join(' ');
    const hit = this.currentVfs(rt).resolveFile(path, rt.cwd);
    if (!hit) {
      const elsewhere = locateFileOnNode(this.currentVfs(rt).rootDir, path.split('/').pop() ?? path);
      if (elsewhere) {
        ev.push(print(`[-] not in this directory — it's at ${elsewhere}.`, 'warn'));
      } else {
        const guess = suggestFile(this.currentVfs(rt), rt.cwd, path);
        ev.push(print(`[-] no such file: ${path}${guess ? ` — did you mean '${guess}'?` : ''}`, 'bad'));
      }
      return;
    }
    if (hit.file.tag === 'target') {
      ev.push(print('[-] contract-locked: flagged files cannot be deleted. download them.', 'warn'));
      return;
    }
    if (hit.file.tag === 'loot') {
      ev.push(print('[-] extraction-locked: the Broker forbids burning loot. download or leave it.', 'warn'));
      return;
    }
    const nodeId = rt.spec.nodes[rt.currentIdx]!.id;
    this.currentVfs(rt).removeFile(path, rt.cwd);
    rt.pulled.add(`${nodeId}|${absPathOf(rt.cwd, path, hit.file.name)}`);
    if (hit.file.tag === 'log') {
      rt.logsWiped++;
      this.addTrace(rt, CONFIG.trace.rmLog, 'log-wipe', ev);
      ev.push(print(`[+] tracks cleared: ${hit.file.name} — trace ${CONFIG.trace.rmLog}`, 'good'));
      ev.push({ t: 'sfx', name: 'ok' });
      ev.push({ t: 'flash', kind: 'good' });
      this.tutorialAdvance(rt, 'rm-log', ev);
    } else {
      ev.push(print(`[+] deleted: ${hit.file.name}. it never existed.`, 'dim'));
    }
  }

  /* ------------------------------ escape tools ------------------------------ */

  private cmdProxy(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.tools.proxy <= 0) {
      ev.push(print('[-] no proxy relays left this job.', 'bad'));
      return;
    }
    rt.tools.proxy--;
    if (rt.spec.kind === 'contract') this.profile.telemetry.proxiesBurned++;
    this.addTrace(rt, -CONFIG.tools.proxyHopReduction, 'proxy-hop', ev);
    ev.push(
      print(`[+] proxy hop — tunnel rerouted through a burner. trace −${CONFIG.tools.proxyHopReduction}`, 'good')
    );
    ev.push({ t: 'sfx', name: 'ok' });
    ev.push({ t: 'flash', kind: 'good' });
  }

  private cmdDecoy(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.tools.decoy <= 0) {
      ev.push(print('[-] no decoys left this job.', 'bad'));
      return;
    }
    if (rt.phase === 'quiet') {
      ev.push(print('[-] nothing is hunting you yet. save it.', 'warn'));
      return;
    }
    rt.tools.decoy--;
    if (rt.spec.kind === 'contract') this.profile.telemetry.decoysBurned++;
    rt.decoyTimer = CONFIG.tools.decoyOccupySeconds;
    const far = rt.spec.nodes[rt.spec.nodes.length - 1]!;
    rt.watchdogNodeId = far.id;
    ev.push(
      print(`[+] decoy lit — watchdog diverted to ${far.hostname} for ~${CONFIG.tools.decoyOccupySeconds}s.`, 'good')
    );
    ev.push({ t: 'sfx', name: 'ok' });
    ev.push({ t: 'state' });
  }

  private cmdDisconnect(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.transfer) {
      ev.push(print('[-] transfer aborted mid-flight — that file is gone.', 'bad'));
      rt.transfer = null;
    }
    if (rt.puzzle) {
      rt.puzzle = null;
      ev.push({ t: 'puzzleClose' });
      ev.push(print('you slice the tunnel mid-lock.', 'dim'));
    }
    const clean = rt.trace < CONFIG.trace.cleanExitUnder;
    this.finishMission(rt, clean ? 'clean' : 'messy', ev);
  }

  private cmdSkipIntro(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.spec.kind !== 'tutorial') {
      ev.push(print('no intro to skip mid-contract. `disconnect` ends the run.', 'dim'));
      return;
    }
    rt.ended = true;
    this.rt = null;
    this.mode = 'home';
    ev.push({ t: 'clear' });
    ev.push(print('[-] tutorial skipped. `contracts` for the board — `run 1` is open.', 'warn'));
    this.setSuggest(ev, 'contracts');
  }

  /* -------------------------------- puzzles -------------------------------- */

  private puzzleAnswer(rt: Runtime, _verb: string, raw: string, ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    if (!raw.trim()) {
      ev.push(print(`[-] ${p.family === 'cipher' ? 'input a word' : 'input a number'}.`, 'bad'));
      return;
    }
    // A single bare number against a knock lock = one progressive knock.
    if (p.family === 'portknock' && /^\d+$/.test(raw.trim())) {
      this.puzzleKnockStep(rt, raw.trim(), ev);
      return;
    }
    p.attempts++;
    const forced = p.forcedSuccess && p.attempts === 1;
    let grade: Grade;
    if (forced) {
      grade = 'correct';
    } else if (p.family === 'sequence') {
      grade = gradeSequence(p, raw);
    } else if (p.family === 'cipher') {
      grade = gradeCipher(p, raw);
    } else {
      grade = 'wrong';
    }
    if (grade === 'correct') {
      if (forced && rt.spec.kind === 'tutorial') {
        ev.push(print("(the lock was pre-disarmed for you. you're welcome.)", 'dim'));
        const seq = p.sequence;
        if (seq) {
          ev.push(
            print(`(the trick: ${seq.terms.join(' · ')} — each term ×2, and 8 × 2 = ${seq.answer}. locks love patterns: \`man breach\` lists them all.)`, 'dim')
          );
        }
      }
      this.breachSuccess(rt, ev);
    } else if (p.family === 'sequence') {
      this.puzzleFail(rt, ev, `[-] ${raw.trim()} rejected — the pattern disagrees.`);
    } else {
      this.puzzleFail(rt, ev, `[-] '${raw.trim().toUpperCase()}' rejected — the plaque stays dark.`);
    }
    this.tutorialAdvance(rt, 'input', ev);
  }

  private puzzleKnock(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    if (p.family !== 'portknock') {
      ev.push(print('[-] this lock does not knock. `input <answer>`.', 'bad'));
      return;
    }
    const ports = args.map((a) => parseInt(a, 10)).filter((n) => Number.isFinite(n));
    if (!ports.length) {
      ev.push(print('[-] knock which ports? `knock 22 443 ...`', 'bad'));
      return;
    }
    p.attempts++;
    if (gradeKnock(p, ports) === 'correct') {
      this.breachSuccess(rt, ev);
    } else {
      this.puzzleFail(rt, ev, '[-] sequence refused — the buffer trips. from the top.');
      p.knock!.entered = [];
    }
    this.tutorialAdvance(rt, 'input', ev);
  }

  /** Single-port progressive knocking (`22` instead of `knock 22 443 ...`). */
  private puzzleKnockStep(rt: Runtime, port: string, ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    p.attempts++;
    const want = p.knock!.ports;
    const got = p.knock!.entered.length;
    if (parseInt(port, 10) === want[got]) {
      p.knock!.entered.push(parseInt(port, 10));
      ev.push(print(`  [${got + 1}/${want.length}] port ${port} — held.`, 'info'));
      if (p.knock!.entered.length === want.length) {
        this.breachSuccess(rt, ev);
      }
    } else {
      this.puzzleFail(
        rt,
        ev,
        `[-] port ${port} refused${got > 0 ? ` after ${got} good knock${got === 1 ? '' : 's'}` : ''} — buffer resets.`
      );
      p.knock!.entered = [];
    }
    this.tutorialAdvance(rt, 'input', ev);
  }

  private puzzleFail(rt: Runtime, ev: EngineEvent[], message: string): void {
    ev.push(print(message, 'bad'));
    if (rt.spec.kind === 'contract') this.profile.telemetry.lockFailures++;
    this.addTrace(rt, CONFIG.trace.failedPuzzle, 'puzzle-fail', ev);
    ev.push({ t: 'sfx', name: 'err' });
    ev.push({ t: 'shake', power: 0.6 });
  }

  private puzzleSkip(rt: Runtime, ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    rt.puzzle = null;
    ev.push({ t: 'puzzleClose' });
    ev.push(print('[+] lock bypassed — brute force, ugly, effective. trace +25.', 'warn'));
    this.addTrace(rt, CONFIG.trace.skipPuzzle, 'skip', ev);
    ev.push({ t: 'sfx', name: 'skip' });
    if (rt.spec.kind === 'contract') this.profile.telemetry.locksSkipped++;
    this.breachOpenNode(rt, p.nodeId, ev);
  }

  private puzzleHintCmd(rt: Runtime, ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    const cost = hintCostFor(this.profile);
    if (this.profile.cash < cost) {
      ev.push(
        print(`[-] consulting fee is $${cost}. you're broke. \`skip\` is free (in trace).`, 'warn')
      );
      return;
    }
    this.profile.cash -= cost;
    if (rt.spec.kind === 'contract') this.profile.telemetry.hintsBought++;
    if (p.family === 'cipher') p.cipher!.hinted = true;
    if (p.family === 'portknock') p.knock!.showLeft = 3;
    ev.push(print(puzzleHint(p), 'accent'));
    ev.push(print(`[-$${cost} · cash $${Math.round(this.profile.cash)}]`, 'dim'));
    ev.push({ t: 'sfx', name: 'hint' });
    ev.push({ t: 'state' });
  }

  private tickPuzzle(rt: Runtime, dt: number, ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    if (p.family === 'portknock' && p.knock!.showLeft > 0) {
      p.knock!.showLeft -= dt;
      if (p.knock!.showLeft <= 0) {
        p.knock!.showLeft = 0;
        ev.push(print('· · · ports dark · · ·  repeat from memory: `knock <p1> <p2> ...`', 'warn'));
        ev.push({ t: 'puzzleOpen', puzzle: puzzleView(p) });
      }
    }
    p.elapsed += dt;
    const left = p.timeLimit - p.elapsed;
    if (left <= p.timeLimit / 2 && !rt.fuseHalf) {
      rt.fuseHalf = true;
      ev.push(print(`[!] fuse at half — ${Math.ceil(Math.max(0, left))}s`, 'warn'));
    }
    if (left <= p.timeLimit / 4 && !rt.fuseQuarter) {
      rt.fuseQuarter = true;
      ev.push(print(`[!] FUSE BURNING — ${Math.ceil(Math.max(0, left))}s`, 'bad'));
      ev.push({ t: 'glitch' });
    }
    if (left <= 0) {
      const burnedNode = rt.spec.nodes.find((n) => n.id === p.nodeId)!;
      rt.puzzle = null;
      ev.push({ t: 'puzzleClose' });
      ev.push(print('[−] the fuse burned. the lock re-arms itself.', 'bad'));
      if (rt.spec.kind === 'contract') this.profile.telemetry.lockFailures++;
      this.addTrace(rt, CONFIG.trace.failedPuzzle, 'puzzle-fail', ev);
      ev.push({ t: 'sfx', name: 'err' });
      ev.push(print('    `breach <ip>` to try again · `skip` (+25 trace) to force it.', 'dim'));
      // Guidance must follow the state: the old suggestion (`input …`) is now a
      // dead end, so point straight back at the breach (never a loop, PRD §2.1).
      if (rt.spec.kind === 'tutorial') {
        this.tutorialRewind(rt, 'breach', ev);
      } else {
        this.setSuggest(ev, `breach ${burnedNode.ip}`);
        ev.push({ t: 'handler', text: `Lock's re-armed. Go again: \`breach ${burnedNode.ip}\`.` });
      }
    }
  }

  private breachSuccess(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.spec.kind === 'contract') this.profile.telemetry.locksSolved++;
    this.breachOpenNode(rt, rt.puzzle!.nodeId, ev);
  }

  /** The shared "this node falls" path for solved locks and skips. */
  private breachOpenNode(rt: Runtime, nodeId: string, ev: EngineEvent[]): void {
    const idx = rt.spec.nodes.findIndex((n) => n.id === nodeId);
    const node = rt.spec.nodes[idx]!;
    if (rt.firstBreachAt === null && rt.spec.kind === 'contract') {
      rt.firstBreachAt = rt.elapsed;
    }
    let cost = CONFIG.trace.breachBySecurity[node.security]!;
    if (rt.watchdogNodeId === nodeId && rt.decoyTimer <= 0) {
      cost *= CONFIG.trace.watchdogBreachMultiplier;
      ev.push(print('[!!] the watchdog watched you do that — breach cost DOUBLED.', 'bad'));
      ev.push({ t: 'glitch' });
    }
    if (rt.puzzle) {
      rt.puzzle = null;
      ev.push({ t: 'puzzleClose' });
    }
    rt.breached.add(nodeId);
    rt.currentIdx = idx;
    rt.cwd = [];
    rt.sessionXp += CONFIG.economy.xpPerNode;
    if (cost > 0) this.addTrace(rt, cost, 'breach', ev);
    ev.push(print(`[+] ACCESS GRANTED — ${node.hostname} is yours.${cost > 0 ? ` (trace +${cost})` : ''}`, 'good'));
    ev.push({ t: 'sfx', name: 'breachHit' });
    ev.push({ t: 'flash', kind: 'good' });
    const targets = countTargets(node.root, rt.downloadedTargets);
    if (targets > 0) {
      ev.push(print(`    flagged files on this node: ${targets} — \`ls\`, then \`download\`.`, 'loot'));
    }
    const logs = countLogsOn(node);
    if (logs > 0) {
      ev.push(print(`    logs here: ${logs} — \`rm\` buys trace margin.`, 'log'));
    }
    this.checkObjective(rt, ev);
    ev.push({ t: 'state' });
  }

  /* --------------------------------- trace --------------------------------- */

  private addTrace(rt: Runtime, delta: number, cause: TraceCause, ev: EngineEvent[]): void {
    if (rt.ended) return;
    const cap = rt.spec.kind === 'tutorial' ? CONFIG.trace.tutorialCap : CONFIG.escalation.bustedAt;
    const before = rt.trace;
    rt.trace = Math.max(0, Math.min(cap, rt.trace + delta));
    const applied = rt.trace - before;
    if (applied !== 0) {
      rt.breakdown.set(cause, (rt.breakdown.get(cause) ?? 0) + applied);
      ev.push({ t: 'trace', value: Math.round(rt.trace), delta: Math.round(applied * 10) / 10, cause });
    }
    const phase = phaseFor(rt.trace);
    if (phase !== rt.phase) this.enterPhase(rt, rt.phase, phase, ev);
    if (rt.trace >= CONFIG.escalation.bustedAt && rt.spec.kind !== 'tutorial') {
      this.startBusted(rt, ev);
    }
  }

  private enterPhase(rt: Runtime, prev: Phase, next: Phase, ev: EngineEvent[]): void {
    rt.phase = next;
    const strength = (p: Phase) => (p === 'quiet' ? 0 : p === 'watchdog' ? 1 : 2);
    if (strength(next) > strength(prev)) {
      if (next === 'watchdog') {
        rt.watchdogNodeId = rt.rng.pick(rt.spec.nodes.slice(1)).id;
        rt.watchdogTimer = CONFIG.tools.watchdogMoveSeconds;
        ev.push(print('[!!] TRACE 50% — WATCHDOG DAEMON spawned. it patrols the chain;', 'bad'));
        ev.push(print('     breaching its node costs double. `decoy` buys time.', 'bad'));
        ev.push({ t: 'sfx', name: 'alarm' });
        ev.push({ t: 'shake', power: 0.5 });
        ev.push({ t: 'handler', text: "Watchdog's up. Watch the map — work around it." });
      } else if (next === 'alert') {
        ev.push(print('[!!] TRACE 75% — ADMIN ALERT. creep is doubled. the room is red.', 'bad'));
        ev.push(print('     finish it, `proxy hop`, or be gone. NOW.', 'bad'));
        ev.push({ t: 'sfx', name: 'alarm' });
        ev.push({ t: 'glitch' });
        ev.push({ t: 'shake', power: 1 });
        ev.push({ t: 'handler', text: "That pulse in your eyes? That's an admin alert. Move." });
      }
    } else {
      // De-escalation (proxy hop, log wipes) — legible relief.
      if (next === 'watchdog') {
        ev.push(print('[+] admin alert cleared — creep back to baseline. the watchdog is still out there.', 'good'));
      } else if (next === 'quiet') {
        rt.watchdogNodeId = null;
        ev.push(print('[+] trace cooled below 50% — the watchdog loses interest and drops away.', 'good'));
        ev.push({ t: 'sfx', name: 'ok' });
      }
    }
    ev.push({ t: 'state' });
  }

  private startBusted(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.cutscene) return;
    const tracePct = Math.round(rt.trace);
    if (rt.transfer) rt.transfer = null;
    if (rt.puzzle) {
      rt.puzzle = null;
      ev.push({ t: 'puzzleClose' });
    }
    const lines = [
      { delay: 0.05, text: '[!!] TRACE 100% — COUNTER-TRACE LOCKS ON', cls: 'bad' as Cls },
      { delay: 0.8, text: '     ▓▓ your tunnel folds like a paper tower ▓▓', cls: 'warn' as Cls },
      { delay: 0.8, text: '     someone severs the session mid-byte.', cls: 'warn' as Cls },
      { delay: 0.9, text: `"Trace was at ${tracePct}%. so close." — the Broker`, cls: 'handler' as Cls },
      { delay: 0.9, text: '[−] BUSTED — mission loot lost · XP halved', cls: 'bad' as Cls },
      { delay: 0.2, text: '     [ENTER] retry the same seed · `contracts` for the board', cls: 'dim' as Cls },
    ];
    rt.cutscene = {
      lines: lines.slice(1),
      timer: lines[0]!.delay,
      then: () => this.finishMission(rt, 'busted', ev),
    };
    ev.push(print(lines[0]!.text, lines[0]!.cls, 'instant'));
    ev.push({ t: 'sfx', name: 'busted' });
    ev.push({ t: 'shake', power: 1.6 });
    ev.push({ t: 'flash', kind: 'bad' });
  }

  /* ------------------------------- transfers ------------------------------- */

  private tickTransfer(rt: Runtime, dt: number, ev: EngineEvent[]): void {
    const tr = rt.transfer!;
    this.addTrace(rt, CONFIG.trace.downloadPerSecond * dt, 'download', ev);
    if (!rt.transfer) return; // busted mid-transfer
    tr.progress = Math.min(1, tr.progress + dt / transferSecondsFor(this.profile));
    if (tr.progress >= tr.nextProgressAt) {
      tr.nextProgressAt = Math.min(1.01, tr.progress + 0.2);
      ev.push({ t: 'progress', pct: Math.round(tr.progress * 100), label: tr.file.name });
    }
    if (tr.progress >= 1) {
      rt.transfer = null;
      const f = tr.file;
      tr.dir.files = tr.dir.files.filter((x) => x !== f);
      rt.pulled.add(`${tr.nodeId}|${tr.path}`);
      rt.downloadsCount++;
      rt.downloadedValue += f.value ?? 0;
      rt.sessionCash += f.value ?? 0;
      rt.sessionXp += CONFIG.economy.xpPerFile;
      if (f.targetId) rt.downloadedTargets.add(f.targetId);
      ev.push({ t: 'progress', pct: 100, label: f.name });
      ev.push(print(`[+] download complete: ${f.name} (+$${f.value})`, 'good'));
      ev.push({ t: 'sfx', name: 'cash' });
      this.checkObjective(rt, ev);
      this.tutorialAdvance(rt, 'download-complete', ev);
      ev.push({ t: 'state' });
    }
  }

  private checkObjective(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.downloadedTargets.size >= rt.spec.requiredTargets) {
      ev.push(
        print(
          `[★] OBJECTIVE MET — ${rt.downloadedTargets.size}/${rt.spec.requiredTargets} files on your rig.`,
          'good'
        )
      );
      ev.push(print('    `disconnect` below 50% trace for the clean-exit bonus.', 'dim'));
      ev.push({ t: 'handler', text: "That's the haul. Bring it home — cold." });
    }
  }

  /* ------------------------------- mission end ------------------------------ */

  private finishMission(rt: Runtime, outcome: MissionResult['outcome'], ev: EngineEvent[]): void {
    if (rt.ended) return;
    rt.ended = true;
    const isTutorial = rt.spec.kind === 'tutorial';
    const success = outcome !== 'busted' && rt.downloadedTargets.size >= rt.spec.requiredTargets;
    const clean = outcome === 'clean';

    let cash = 0;
    let xp = rt.sessionXp;
    let cleanBonus = 0;
    let missionBonus = 0;
    if (outcome !== 'busted') {
      cash += rt.sessionCash;
      if (clean) {
        cleanBonus = Math.round(rt.sessionCash * (CONFIG.economy.cleanMultiplier - 1));
        cash += cleanBonus;
        xp += CONFIG.economy.xpCleanBonus;
      }
      cash += rt.logsWiped * CONFIG.economy.cashPerLog;
      if (success && rt.spec.kind === 'contract') {
        missionBonus =
          CONFIG.economy.missionBonus[Math.min(rt.spec.index, CONFIG.economy.missionBonus.length - 1)]!;
        cash += missionBonus;
      }
    } else {
      xp = Math.round(xp * CONFIG.economy.bustedXpFactor);
    }

    const rankBefore = rankFor(this.profile.xp).name;
    this.profile.cash += cash;
    this.profile.xp += xp;
    if (success && isTutorial) this.profile.tutorialDone = true;
    if (success && rt.spec.kind === 'contract' && rt.spec.index === this.profile.contractsDone + 1) {
      this.profile.contractsDone = rt.spec.index;
    }
    // telemetry: outcome counters + trace samples + session bookkeeping
    if (rt.spec.kind === 'contract') {
      const t = this.profile.telemetry;
      t.runsEnded++;
      if (outcome === 'busted') t.runsBusted++;
      else if (success) t.runsCompleted++;
      else t.runsShort++;
      if (rt.firstBreachAt !== null) {
        t.firstBreachSum += rt.firstBreachAt;
        t.firstBreachCount++;
      }
      t.finalTraceSum += rt.trace;
      t.finalTraceCount++;
      const now = this.now();
      if (t.lastPlayedAt === 0 || now - t.lastPlayedAt > CONFIG.stats.sessionGapMs) t.sessions++;
      t.lastPlayedAt = now;
    }
    const rankAfter = rankFor(this.profile.xp).name;
    const rankedUp = rankAfter !== rankBefore ? rankAfter : null;

    this.lastResult = {
      outcome,
      missionName: rt.spec.name,
      index: rt.spec.index,
      seed: rt.spec.seed,
      isTutorial,
      trace: Math.round(rt.trace),
      cash,
      xp,
      filesStolen: rt.downloadedTargets.size,
      filesRequired: rt.spec.requiredTargets,
      logsWiped: rt.logsWiped,
      cleanBonus,
      missionBonus,
      breakdown: [...rt.breakdown.entries()]
        .map(([label, delta]) => ({ label, delta: Math.round(delta * 10) / 10 }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
      rankBefore,
      rankAfter: rankedUp,
    };

    ev.push(print('', 'dim'));
    ev.push(
      print('─────────────────────── AFTER-ACTION ────────────────────', outcome === 'busted' ? 'bad' : clean ? 'good' : 'warn', 'instant')
    );
    if (outcome === 'busted') {
      ev.push(print(`outcome   BUSTED at ${this.lastResult.trace}% trace`, 'bad'));
      ev.push(print('cash      $0 (the grid keeps it)', 'bad'));
      ev.push(print(`xp        +${xp} (halved)`, 'warn'));
    } else if (!success) {
      ev.push(
        print(
          `outcome   EXTRACTED EARLY at ${this.lastResult.trace}% trace — ${rt.downloadedTargets.size}/${rt.spec.requiredTargets} files · contract UNPAID`,
          'warn'
        )
      );
      ev.push(print(`xp        +${xp} (the work counted, the job didn't)`, 'warn'));
    } else {
      ev.push(print(`outcome   ${clean ? 'CLEAN EXIT' : 'HOT EXIT'} at ${this.lastResult.trace}% trace`, clean ? 'good' : 'warn'));
      const greed = rt.downloadsCount - rt.downloadedTargets.size;
      ev.push(
        print(
          `files     ${rt.downloadedTargets.size}/${rt.spec.requiredTargets} flagged${greed > 0 ? ` (+${greed} greed)` : ''}`,
          'info'
        )
      );
      ev.push(
        print(
          `loot      $${rt.sessionCash}${cleanBonus ? ` · clean bonus +$${cleanBonus}` : ''}${missionBonus ? ` · contract bonus +$${missionBonus}` : ''}`,
          'good'
        )
      );
      if (rt.logsWiped) ev.push(print(`logs      ${rt.logsWiped} wiped (+$${rt.logsWiped * CONFIG.economy.cashPerLog})`, 'good'));
      ev.push(print(`payout    $${cash} · xp +${xp}`, 'good'));
    }
    ev.push(print('trace breakdown:', 'dim'));
    for (const b of this.lastResult.breakdown) {
      ev.push(print(`  ${pad(b.label, 14)} ${b.delta > 0 ? '+' : ''}${b.delta}`, b.delta > 0 ? 'warn' : 'good'));
    }
    if (rankedUp) {
      ev.push(print(`[★] RANK UP — the wire now calls you ${rankedUp}.`, 'accent'));
    }
    ev.push(print('─────────────────────────────────────────────────────────', 'dim', 'instant'));

    if (isTutorial) {
      ev.push(print('tutorial complete. the glow is gone now — but `help` never leaves.', 'accent'));
      ev.push(print('contracts are open: `run 1`. same verbs, real teeth.', 'info'));
      this.setSuggest(ev, 'run 1');
      ev.push({ t: 'sfx', name: 'clean' });
    } else if (outcome === 'busted') {
      ev.push({ t: 'sfx', name: 'busted' });
      this.setSuggest(ev, 'retry');
    } else if (!success) {
      ev.push(print('the Broker, dryly: "short delivery. no sticker." `retry` when ready.', 'handler'));
      this.setSuggest(ev, 'retry');
      ev.push({ t: 'sfx', name: 'ok' });
    } else if (clean) {
      ev.push(print('the Broker pings one word: "clean." high praise.', 'handler'));
      this.setSuggest(ev, 'contracts');
      ev.push({ t: 'sfx', name: 'clean' });
      ev.push({ t: 'flash', kind: 'good' });
    } else {
      ev.push({ t: 'sfx', name: 'ok' });
      this.setSuggest(ev, 'contracts');
    }

    // The tutorial lands on the home terminal: its suggestion (`run 1`) is a
    // home verb, and ENTER there can't silently re-run the tutorial (PRD §11
    // onboarding must never loop). Real contracts use the post screen, where
    // [ENTER] = instant retry is the designed loop.
    this.mode = isTutorial ? 'home' : 'post';
    this.rt = null;
    this.pendingSession = null;
    ev.push({ t: 'missionEnd', result: this.lastResult });
    ev.push({ t: 'state' });
    this.persist();
  }

  /* -------------------------------- tutorial ------------------------------- */

  private tutorialAdvance(rt: Runtime, marker: string, ev: EngineEvent[]): void {
    if (rt.spec.kind !== 'tutorial' || rt.ended) return;
    const step = TUTORIAL_STEPS[rt.tutorialStep];
    if (!step || step.advanceOn !== marker) return;
    rt.tutorialStep++;
    const next = TUTORIAL_STEPS[rt.tutorialStep];
    if (next) {
      this.setSuggest(ev, next.cmd.join(' '));
      if (next.note) {
        ev.push({ t: 'handler', text: `Next: \`${next.cmd.join(' ')}\` — ${next.note}. TAB fills it.` });
      }
    }
  }

  /** Pull the tutorial back to an earlier step (a burnt fuse re-arms its lock,
   *  so the glow must lead back to `breach`, not keep shouting `input`). */
  private tutorialRewind(rt: Runtime, marker: string, ev: EngineEvent[]): void {
    if (rt.spec.kind !== 'tutorial' || rt.ended) return;
    const idx = TUTORIAL_STEPS.findIndex((s) => s.advanceOn === marker);
    if (idx < 0 || idx > rt.tutorialStep) return;
    rt.tutorialStep = idx;
    const step = TUTORIAL_STEPS[idx]!;
    this.setSuggest(ev, step.cmd.join(' '));
    ev.push({ t: 'handler', text: `Lock re-armed — the glow rewound with it. Next: \`${step.cmd.join(' ')}\`. TAB fills it.` });
  }

  /** Tutorial guard: while a step is pending, off-script verbs get a gentle nudge. */
  private tutorialGate(rt: Runtime, verb: string, args: string[], ev: EngineEvent[]): boolean {
    if (rt.spec.kind !== 'tutorial') return true;
    const exempt = ['help', '?', 'man', 'clear', 'cls', 'skipintro', 'profile', 'settings'];
    if (exempt.includes(verb)) return true;
    const step = TUTORIAL_STEPS[rt.tutorialStep];
    if (!step) return true;
    // Aliases count as the verb (`dl` is `download` even while the glow is on).
    const canonical = lookupCommand(verb)?.name ?? verb;
    // Equivalent arguments count too: `breach ledgercube` is the same node as
    // `breach 10.0.0.12`, `rm auth.log` the same file as `rm /var/log/auth.log`.
    const argMatch =
      step.cmd.length === 1 ||
      (() => {
        const given = (args[0] ?? '').toLowerCase();
        const want = step.cmd[1]!.toLowerCase();
        if (given === want) return true;
        if (given.split('/').pop() === want.split('/').pop()) return true;
        const wanted = this.resolveNode(rt, want);
        const givenNode = this.resolveNode(rt, given);
        return !!wanted && !!givenNode && wanted.id === givenNode.id;
      })();
    if (step.cmd[0] === canonical && argMatch) return true;
    // At the lock, any `input <x>` is on-script — the forced first-try success
    // exists precisely so the rookie's answer lands (PRD §11).
    if (step.cmd[0] === 'input' && verb === 'input') return true;
    // A bare number typed at the lock counts as `input <n>`.
    if (step.cmd[0] === 'input' && /^\d+$/.test(verb)) return true;
    ev.push({ t: 'handler', text: `Focus. Next move: \`${step.cmd.join(' ')}\` — ${step.note}.` });
    ev.push(print(`[handler] the glow knows best: \`${step.cmd.join(' ')}\``, 'warn'));
    this.setSuggest(ev, step.cmd.join(' '));
    return false;
  }

  /* -------------------------------- helpers -------------------------------- */

  private later(rt: Runtime, seconds: number, then: () => void): void {
    rt.pending = { remaining: seconds, then };
  }

  private currentVfs(rt: Runtime): Vfs {
    return rt.vfs.get(rt.spec.nodes[rt.currentIdx]!.id)!;
  }

  private resolveNode(rt: Runtime, q: string): MissionSpec['nodes'][number] | null {
    const query = q.trim().toLowerCase();
    if (!query) return null;
    return (
      rt.spec.nodes.find((n) => n.ip.toLowerCase() === query) ??
      rt.spec.nodes.find((n) => n.hostname.toLowerCase() === query) ??
      rt.spec.nodes.find((n) => n.id.toLowerCase() === query) ??
      null
    );
  }

  private completePath(rt: Runtime, input: string, tokens: string[]): { items: string[]; from: number } {
    const raw = tokens.slice(1).join(' ');
    const slash = raw.lastIndexOf('/');
    const dirPart = slash >= 0 ? raw.slice(0, slash + 1) : '';
    const prefix = slash >= 0 ? raw.slice(slash + 1) : raw;
    const dir = this.currentVfs(rt).resolveDir(dirPart || '.', rt.cwd);
    if (!dir) return { items: [], from: input.length - prefix.length };
    const items: string[] = [];
    for (const d of dir.dirs ?? []) {
      if (d.name.toLowerCase().startsWith(prefix.toLowerCase())) items.push(dirPart + d.name + '/');
    }
    for (const f of dir.files) {
      if (f.name.toLowerCase().startsWith(prefix.toLowerCase())) items.push(dirPart + f.name);
    }
    return { items, from: input.length - prefix.length };
  }

  private moveWatchdog(rt: Runtime, ev: EngineEvent[]): void {
    const idx = rt.spec.nodes.findIndex((n) => n.id === rt.watchdogNodeId);
    const options: number[] = [];
    if (idx > 1) options.push(idx - 1);
    if (idx < rt.spec.nodes.length - 1) options.push(idx + 1);
    if (options.length) {
      rt.watchdogNodeId = rt.spec.nodes[rt.rng.pick(options)]!.id;
      ev.push({ t: 'state' });
    }
  }

  private nodeView(rt: Runtime, n: MissionSpec['nodes'][number], i: number): NodeView {
    return {
      id: n.id,
      ip: n.ip,
      hostname: n.hostname,
      security: n.security,
      status: i === 0 ? 'entry' : rt.breached.has(n.id) ? 'breached' : 'locked',
      isCurrent: i === rt.currentIdx,
      hasTarget: countTargets(n.root, rt.downloadedTargets) > 0,
      lootValue: sumLoot(n.root),
      logsLeft: countLogsOn(n),
      scanned: rt.scanned,
    };
  }

  private prompt(): string {
    if (this.mode === 'mission' && this.rt) {
      const host = this.rt.spec.nodes[this.rt.currentIdx]!.hostname.toLowerCase();
      const cwd = '/' + this.rt.cwd.join('/');
      return `operator@${host}:${cwd}$`;
    }
    return 'operator@homegrid:~$';
  }

  private setSuggest(ev: EngineEvent[], cmd: string): void {
    this.suggest = cmd;
    ev.push({ t: 'suggest', cmd });
  }

  private printHelp(ev: EngineEvent[], mode: GameMode): void {
    ev.push(print('GRID TRUST FIELD CARD 07 — verbs you get paid for:', 'accent'));
    for (const c of commandsForMode(mode === 'post' ? 'home' : mode)) {
      ev.push(print(`  ${pad(c.usage, 30)} ${c.summary}`, 'info'));
    }
    ev.push(print('  `man <verb>` for the long version.', 'dim'));
  }

  private printMan(args: string[], ev: EngineEvent[]): void {
    const q = (args[0] ?? '').toLowerCase();
    if (!q) {
      ev.push(print('[-] man what? `man breach`, `man scan`…', 'bad'));
      return;
    }
    const meta = lookupCommand(q);
    if (!meta) {
      const guess = didYouMean(q, this.mode === 'mission' ? 'mission' : 'home');
      ev.push(print(`[-] no manual entry for '${q}'${guess ? ` — did you mean '${guess}'?` : ''}.`, 'bad'));
      return;
    }
    for (const line of manPage(meta).split('\n')) {
      ev.push(print(line, 'accent', 'instant'));
    }
  }

  private printContracts(ev: EngineEvent[]): void {
    ev.push(print('───[ THE BOARD ]──────────────────────────────────────────', 'accent', 'instant'));
    for (let i = 1; i <= CONFIG.mission.count; i++) {
      const spec = this.getValidatedSpec(i, contractSeedOf(i));
      const done = i <= this.profile.contractsDone;
      const open = i === this.profile.contractsDone + 1;
      const mark = done ? '[✓]' : open ? '[»]' : '[·]';
      ev.push(
        print(
          `  ${mark} #${String(i).padStart(2, '0')}  ${spec.name.padEnd(16)} ${formatSeed(contractSeedOf(i))}  ${done ? 'cleared' : open ? 'READY — `run ' + i + '`' : 'locked'}`,
          done ? 'dim' : open ? 'good' : 'dim'
        )
      );
    }
    ev.push(print('  custom job: `run seed <SEED>` — same seed, same network, always.', 'dim'));
    this.setSuggest(ev, this.profile.tutorialDone ? `run ${this.profile.contractsDone + 1}` : 'tutorial');
  }

  private cmdRun(args: string[], ev: EngineEvent[]): void {
    if (args[0]?.toLowerCase() === 'seed') {
      const seed = args.slice(1).join(' ').trim();
      if (!seed) {
        ev.push(print('[-] run seed what? any string works.', 'bad'));
        return;
      }
      const idx = Math.max(1, Math.min(CONFIG.mission.count, this.profile.contractsDone + 1));
      const spec = this.getValidatedSpec(idx, seed);
      ev.push(print(`[+] custom job generated from seed "${seed}" (difficulty of contract #${idx}).`, 'good'));
      this.startMission(spec, ev);
      return;
    }
    const n = parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(n) || n < 1 || n > CONFIG.mission.count) {
      ev.push(print(`[-] run what? \`run 1\`–\`run ${CONFIG.mission.count}\`, or \`run seed <SEED>\`.`, 'bad'));
      return;
    }
    if (n > this.profile.contractsDone + 1) {
      ev.push(
        print(`[-] contract #${n} is locked. the Broker unlocks in order — clear #${this.profile.contractsDone + 1} first.`, 'warn')
      );
      return;
    }
    const spec = this.getValidatedSpec(n, contractSeedOf(n));
    this.startMission(spec, ev);
  }

  private cmdRetry(ev: EngineEvent[]): void {
    const res = this.lastResult;
    if (!res) {
      ev.push(print('[-] nothing to retry yet.', 'bad'));
      return;
    }
    if (res.isTutorial) {
      this.startMission(tutorialMission(), ev);
      return;
    }
    const spec = this.getValidatedSpec(Math.max(1, res.index), res.seed);
    this.startMission(spec, ev);
  }

  private cmdResume(ev: EngineEvent[]): void {
    if (!this.pendingSession) {
      ev.push(print('nothing to resume.', 'dim'));
      return;
    }
    const s = this.pendingSession;
    try {
      const spec = s.kind === 'tutorial' ? tutorialMission() : this.getValidatedSpec(s.index, s.seed);
      this.startMission(spec, ev);
      this.restoreSession(this.rt!, s, ev);
      this.pendingSession = null;
      ev.push(print('[+] session restored — you were never gone.', 'good'));
      this.persist();
    } catch {
      ev.push(print('[-] the saved session is corrupted beyond rescue. `abandon` it.', 'bad'));
    }
  }

  private cmdSettings(args: string[], ev: EngineEvent[]): void {
    const [key, ...rest] = args;
    const val = rest.join(' ').toLowerCase();
    if (!key) {
      ev.push(
        print(
          `volume ${this.settings.volume} · mute ${this.settings.muted ? 'on' : 'off'} · crt ${this.settings.crt ? 'on' : 'off'} · motion ${this.settings.motion ? 'on' : 'off'}`,
          'info'
        )
      );
      ev.push(
        print('`settings volume 0.5` · `settings mute on|off` · `settings crt on|off` · `settings motion on|off`', 'dim')
      );
      return;
    }
    switch (key.toLowerCase()) {
      case 'volume': {
        const v = parseFloat(val);
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          ev.push(print('[-] volume is 0.0 – 1.0.', 'bad'));
          return;
        }
        this.settings.volume = v;
        this.settings.muted = v === 0;
        break;
      }
      case 'mute':
        if (val !== 'on' && val !== 'off') {
          ev.push(print('[-] mute on|off.', 'bad'));
          return;
        }
        this.settings.muted = val === 'on';
        break;
      case 'crt':
        if (val !== 'on' && val !== 'off') {
          ev.push(print('[-] crt on|off.', 'bad'));
          return;
        }
        this.settings.crt = val === 'on';
        break;
      case 'motion':
        if (val !== 'on' && val !== 'off') {
          ev.push(print('[-] motion on|off.', 'bad'));
          return;
        }
        this.settings.motion = val === 'on';
        break;
      default:
        ev.push(print(`[-] unknown setting '${key}'. volume · mute · crt · motion`, 'bad'));
        return;
    }
    this.persist();
    ev.push(print(`[+] saved: ${key.toLowerCase()} ${val}.`, 'good'));
    ev.push({ t: 'state' });
  }

  private printProfile(ev: EngineEvent[]): void {
    const rank = rankFor(this.profile.xp);
    const next = CONFIG.ranks.find((r) => r.xp > this.profile.xp) ?? null;
    ev.push(print('───[ OPERATOR FILE ]───────────────', 'accent', 'instant'));
    ev.push(print(`  rank     ${rank.name}`, 'accent'));
    ev.push(print(`  xp       ${Math.round(this.profile.xp)}${next ? ` / ${next.xp} (next: ${next.name})` : ' — maxed'}`, 'info'));
    ev.push(print(`  cash     $${Math.round(this.profile.cash)}`, 'good'));
    ev.push(
      print(
        `  cleared  ${this.profile.contractsDone}/${CONFIG.mission.count} contracts${this.profile.tutorialDone ? '' : ' · tutorial pending'}`,
        'dim'
      )
    );
    const owned = CONFIG.shop.items
      .map((i) => ({ item: i, level: upgradeLevel(this.profile, i.id) }))
      .filter((x) => x.level > 0);
    if (owned.length) {
      ev.push(
        print(
          `  rig      ${owned.map((x) => `${x.item.name} ${'·'.repeat(x.level)}`).join(' · ')}`,
          'accent'
        )
      );
    }
  }

  /* --------------------------------- shop ---------------------------------- */

  private printShop(ev: EngineEvent[]): void {
    ev.push(print('───[ THE BROKER\'S MARKET ]────────────────────────', 'accent', 'instant'));
    ev.push(print(`  cash: $${Math.round(this.profile.cash)}`, 'good'));
    for (const item of CONFIG.shop.items) {
      const level = upgradeLevel(this.profile, item.id);
      const owned = level >= item.maxLevel;
      const price = owned ? null : upgradeCost(item.id, level);
      const meter = `${'■'.repeat(level)}${'·'.repeat(item.maxLevel - level)}`;
      ev.push(
        print(
          `  ${pad(item.id, 10)} ${pad(item.name, 18)} ${pad(item.desc, 42)} ${meter} ${
            owned ? 'MAXED' : `$${price}`
          }`,
          owned ? 'dim' : 'info'
        )
      );
    }
    ev.push(print('  `buy <id>` — effects apply to every future job. no refunds.', 'dim'));
  }

  private cmdBuy(args: string[], ev: EngineEvent[]): void {
    const id = (args[0] ?? '').toLowerCase();
    if (!id) {
      ev.push(print('[-] buy what? `shop` lists the catalog.', 'bad'));
      return;
    }
    const item = shopItem(id);
    if (!item) {
      ev.push(print(`[-] no such gear: '${id}'. \`shop\` lists the catalog.`, 'bad'));
      return;
    }
    const level = upgradeLevel(this.profile, id);
    if (level >= item.maxLevel) {
      ev.push(print(`[-] ${item.name} is already maxed (${item.maxLevel}/${item.maxLevel}).`, 'warn'));
      return;
    }
    const price = upgradeCost(id, level);
    if (this.profile.cash < price) {
      ev.push(print(`[-] ${item.name} costs $${price}. you have $${Math.round(this.profile.cash)}.`, 'bad'));
      ev.push({ t: 'sfx', name: 'err' });
      return;
    }
    this.profile.cash -= price;
    this.profile.upgrades[id] = level + 1;
    this.persist();
    ev.push(print(`[+] acquired: ${item.name} (lv ${level + 1}/${item.maxLevel}) — −$${price}`, 'good'));
    ev.push(print(`    ${item.desc}. wired into your rig; next job feels it.`, 'dim'));
    ev.push({ t: 'sfx', name: 'cash' });
    ev.push({ t: 'flash', kind: 'good' });
    ev.push({ t: 'state' });
  }

  /* --------------------------------- stats --------------------------------- */

  private printStats(ev: EngineEvent[]): void {
    const t = this.profile.telemetry;
    const tg = CONFIG.stats.targets;
    ev.push(print('───[ WIRE ANALYTICS — self-report ]────────────────', 'accent', 'instant'));
    if (t.runsStarted === 0) {
      ev.push(print('  no runs on record. `run 1` and come back.', 'dim'));
      return;
    }
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const verdict = (ok: boolean, note: string) =>
      ev.push(print(`      ${ok ? '✓' : '⚠'} ${note}`, ok ? 'good' : 'warn'));

    ev.push(
      print(
        `  runs       ${t.runsStarted} started · ${t.runsCompleted} completed · ${t.runsBusted} busted · ${t.runsShort} short`,
        'info'
      )
    );
    const completion = t.runsCompleted / Math.max(1, t.runsEnded);
    ev.push(print(`  completion ${pct(completion)} (target ≥${pct(tg.completionRate)})`, 'info'));
    verdict(completion >= tg.completionRate, completion >= tg.completionRate ? 'on target' : 'runs end hot or unfinished — ease mid-game security');

    if (t.firstBreachCount) {
      const avg = t.firstBreachSum / t.firstBreachCount;
      ev.push(print(`  first hit  ~${Math.round(avg)}s to first breach (target <${tg.firstBreachMs / 1000}s)`, 'info'));
      verdict(avg < tg.firstBreachMs, avg < tg.firstBreachMs ? 'quick on the wire' : 'slow ramp — cut pre-breach busywork');
    }

    const graded = t.locksSolved + t.locksSkipped;
    if (graded > 0) {
      const skipRate = t.locksSkipped / graded;
      const [lo, hi] = tg.skipRate;
      ev.push(
        print(
          `  locks      ${t.locksEncountered} met · ${t.locksSolved} cracked · ${t.locksSkipped} skipped (${pct(skipRate)}) · ${t.locksSkipped + t.lockFailures} failures`,
          'info'
        )
      );
      verdict(
        skipRate >= lo && skipRate <= hi,
        skipRate < lo
          ? `below ${pct(lo)} — locks may be too easy`
          : skipRate > hi
            ? `above ${pct(hi)} — locks may be too hard`
            : 'sweet spot (10–20%)'
      );
    }

    ev.push(
      print(
        `  tools      ${t.hintsBought} hints · ${t.proxiesBurned} proxy hops · ${t.decoysBurned} decoys`,
        'info'
      )
    );
    if (t.finalTraceCount) {
      const avgTrace = Math.round(t.finalTraceSum / t.finalTraceCount);
      ev.push(print(`  walk-out   avg ${avgTrace}% trace at disconnect`, 'info'));
    }
    if (t.sessions > 0) {
      const per = t.runsEnded / t.sessions;
      ev.push(print(`  rhythm     ~${per.toFixed(1)} runs/session over ${t.sessions} session${t.sessions === 1 ? '' : 's'} (target ≥${tg.missionsPerSession})`, 'info'));
      verdict(per >= tg.missionsPerSession, per >= tg.missionsPerSession ? 'they came back' : 'one-and-done risk — check the difficulty cliff');
    }
  }

  /* ------------------------------- session IO ------------------------------ */

  private snapshotSession(rt: Runtime): SessionSave {
    return {
      kind: rt.spec.kind,
      index: rt.spec.index,
      seed: rt.spec.seed,
      trace: rt.trace,
      rngState: rt.rng.getState(),
      tools: { ...rt.tools },
      currentNodeId: rt.spec.nodes[rt.currentIdx]!.id,
      breached: [...rt.breached],
      downloaded: [...rt.downloadedTargets],
      removed: [...rt.pulled],
      scanned: rt.scanned,
      watchdogNodeId: rt.watchdogNodeId,
      watchdogTimer: rt.watchdogTimer,
      decoyTimer: rt.decoyTimer,
      puzzle: rt.puzzle
        ? {
            family: rt.puzzle.family,
            nodeId: rt.puzzle.nodeId,
            elapsed: rt.puzzle.elapsed,
            attempts: rt.puzzle.attempts,
            forcedSuccess: rt.puzzle.forcedSuccess,
            sequence: rt.puzzle.sequence ? { ...rt.puzzle.sequence } : undefined,
            knock: rt.puzzle.knock
              ? {
                  ports: [...rt.puzzle.knock.ports],
                  entered: [...rt.puzzle.knock.entered],
                  showLeft: Math.max(0, rt.puzzle.knock.showLeft),
                }
              : undefined,
            cipher: rt.puzzle.cipher ? { ...rt.puzzle.cipher } : undefined,
          }
        : null,
      transfer: rt.transfer
        ? { fileId: `${rt.transfer.nodeId}|${rt.transfer.path}`, progress: rt.transfer.progress }
        : null,
      progress: {
        sessionCash: rt.sessionCash,
        sessionXp: rt.sessionXp,
        downloadsCount: rt.downloadsCount,
        downloadedValue: rt.downloadedValue,
        logsWiped: rt.logsWiped,
      },
    };
  }

  private restoreSession(rt: Runtime, s: SessionSave, ev: EngineEvent[]): void {
    rt.trace = s.trace;
    rt.rng = new Rng(`${s.seed}::runtime`, s.rngState);
    rt.tools = { ...s.tools };
    rt.scanned = s.scanned;
    rt.watchdogNodeId = s.watchdogNodeId;
    rt.watchdogTimer = s.watchdogTimer;
    rt.decoyTimer = s.decoyTimer;
    rt.phase = phaseFor(rt.trace);
    rt.currentIdx = Math.max(0, rt.spec.nodes.findIndex((n) => n.id === s.currentNodeId));
    for (const id of s.breached) rt.breached.add(id);
    for (const id of s.downloaded) rt.downloadedTargets.add(id);
    rt.sessionCash = s.progress.sessionCash;
    rt.sessionXp = s.progress.sessionXp;
    rt.downloadsCount = s.progress.downloadsCount;
    rt.downloadedValue = s.progress.downloadedValue;
    rt.logsWiped = s.progress.logsWiped;
    for (const key of s.removed) {
      rt.pulled.add(key);
      const [nodeId, path] = splitPullKey(key);
      const hit = rt.vfs.get(nodeId)?.resolveFile(path, []);
      if (hit) hit.dir.files = hit.dir.files.filter((f) => f !== hit.file);
    }
    if (s.puzzle) {
      const node = rt.spec.nodes.find((n) => n.id === s.puzzle!.nodeId)!;
      rt.puzzle = instantiatePuzzle(
        rt.spec.puzzleAnswers[s.puzzle.nodeId]!,
        s.puzzle.nodeId,
        node.security as 1 | 2 | 3,
        CONFIG.puzzle.timeBoxBySecurity[node.security as 1 | 2 | 3]!,
        s.puzzle.forcedSuccess
      );
      rt.puzzle.elapsed = s.puzzle.elapsed;
      rt.puzzle.attempts = s.puzzle.attempts;
      if (s.puzzle.sequence) rt.puzzle.sequence = s.puzzle.sequence;
      if (s.puzzle.knock && rt.puzzle.knock) {
        rt.puzzle.knock.entered = s.puzzle.knock.entered;
        rt.puzzle.knock.showLeft = s.puzzle.knock.showLeft;
      }
      if (s.puzzle.cipher && rt.puzzle.cipher) rt.puzzle.cipher = s.puzzle.cipher;
      ev.push({ t: 'puzzleOpen', puzzle: puzzleView(rt.puzzle) });
    }
    if (s.transfer) {
      const [nodeId, path] = splitPullKey(s.transfer.fileId);
      const hit = rt.vfs.get(nodeId)?.resolveFile(path, []);
      if (hit && (hit.file.tag === 'loot' || hit.file.tag === 'target')) {
        rt.transfer = {
          nodeId,
          dir: hit.dir,
          file: hit.file,
          path,
          progress: s.transfer.progress,
          nextProgressAt: Math.min(1.01, s.transfer.progress + 0.2),
        };
      }
    }
    ev.push({ t: 'state' });
  }

  /* --------------------------- validated missions --------------------------- */

  /** Validated spec — deterministic in (index, seed); see validate.ts. */
  getValidatedSpec(index: number, seed: string): MissionSpec {
    const key = `${index}::${seed}`;
    let spec = GameEngine.specCache.get(key);
    if (!spec) {
      spec = buildValidatedMission(index, seed);
      GameEngine.specCache.set(key, spec);
    }
    return spec;
  }
}

/* ================================ helpers ================================= */

function print(text: string, cls?: Cls, style?: 'type' | 'instant'): EngineEvent {
  return { t: 'print', text, cls, style };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function phaseFor(trace: number): Phase {
  if (trace >= CONFIG.escalation.alertAt) return 'alert';
  if (trace >= CONFIG.escalation.watchdogAt) return 'watchdog';
  return 'quiet';
}

export function rankFor(xp: number): { name: string; xp: number } {
  let out: { name: string; xp: number } = CONFIG.ranks[0]!;
  for (const r of CONFIG.ranks) {
    if (xp >= r.xp) out = r;
  }
  return out;
}

function walkFiles(root: DirSpec): FileSpec[] {
  const out: FileSpec[] = [];
  const visit = (d: DirSpec) => {
    out.push(...d.files);
    for (const sub of d.dirs ?? []) visit(sub);
  };
  visit(root);
  return out;
}

function countTargets(root: DirSpec, downloaded: Set<string>): number {
  return walkFiles(root).filter((f) => f.tag === 'target' && f.targetId && !downloaded.has(f.targetId)).length;
}

function countLogsOn(node: MissionSpec['nodes'][number]): number {
  return walkFiles(node.root).filter((f) => f.tag === 'log').length;
}

function countLogs(rt: Runtime): number {
  return rt.spec.nodes.reduce((acc, n) => acc + countLogsOn(n), 0);
}

function sumLoot(root: DirSpec): number {
  return walkFiles(root)
    .filter((f) => f.tag === 'loot' || f.tag === 'target')
    .reduce((acc, f) => acc + (f.value ?? 0), 0);
}

function normalizeParts(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out;
}

function absPathOf(cwd: string[], arg: string, fileName: string): string {
  const parts = arg.startsWith('/') ? Vfs.splitPath(arg) : [...cwd, ...Vfs.splitPath(arg)];
  const norm = normalizeParts(parts);
  return '/' + (norm[norm.length - 1] ?? fileName);
}

function splitPullKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Case-insensitive search for a filename anywhere on the node; returns its absolute path. */
function locateFileOnNode(dir: DirSpec, name: string, prefix = '/'): string | null {
  for (const f of dir.files) {
    if (f.name.toLowerCase() === name.toLowerCase()) return prefix + f.name;
  }
  for (const d of dir.dirs ?? []) {
    const hit = locateFileOnNode(d, name, `${prefix}${d.name}/`);
    if (hit) return hit;
  }
  return null;
}

function suggestFile(vfs: Vfs, cwd: string[], arg: string): string | null {
  const base = (arg.split('/').pop() ?? '').toLowerCase();
  const listing = vfs.list('.', cwd);
  if (!listing) return null;
  let best: string | null = null;
  let bestD = 3;
  for (const f of listing.files) {
    const d = editDistanceLower(f.name.toLowerCase(), base);
    if (d < bestD) {
      bestD = d;
      best = f.name;
    }
  }
  for (const d of listing.dirs) {
    const dd = editDistanceLower(d.toLowerCase(), base);
    if (dd < bestD) {
      bestD = dd;
      best = d + '/';
    }
  }
  return bestD <= 2 ? best : null;
}

function editDistanceLower(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
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

function cloneSpecTree(root: DirSpec): DirSpec {
  return JSON.parse(JSON.stringify(root)) as DirSpec;
}

function homeBanner(): string {
  return [
    '┌─────────────────────────────────────────────────┐',
    '│   C Y B E R G R I D          burner terminal    │',
    '│   the grid keeps the ledger. you keep the cut.  │',
    '└─────────────────────────────────────────────────┘',
  ].join('\n');
}

function missionBanner(spec: MissionSpec): string {
  const kindLabel = spec.kind === 'tutorial' ? 'MISSION 0 — WARM-UP' : `CONTRACT #${spec.index}`;
  const line1 = `MISSION: ${spec.name.toUpperCase()}`.slice(0, 47).padEnd(47, ' ');
  const line2 = `${kindLabel} · seed ${formatSeed(spec.seed)}`.padEnd(47, ' ');
  return [
    '┌─────────────────────────────────────────────────┐',
    `│ ${line1} │`,
    `│ ${line2} │`,
    '└─────────────────────────────────────────────────┘',
  ].join('\n');
}

// re-exported for tests / validator convenience
export { CONFIG, formatSeed, generateMission, contractSeedOf as contractSeed, tutorialMission };
export type { EngineEvent, MissionSpec, Snapshot, SaveBlob };
