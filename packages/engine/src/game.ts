import { CONFIG } from './config.js';
import { COMMANDS, commandsForMode, didYouMean, lookupCommand, manPage } from './commands.js';
import {
  FAMILY_LABEL,
  cipherWheel,
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
import { shopItem, upgradeCost, upgradeLevel } from './shop.js';
import { tutorialMission, TUTORIAL_STEPS } from './tutorial.js';
import { buildValidatedMission, MissionUnavailableError } from './validate.js';
import { generateFor, generateMission } from './missions.js';
import { CAMPAIGN_CODENAMES } from './gen/v2.js';
import {
  campaignDescriptor,
  contractSeed as contractSeedOf,
  customDescriptor,
  dailyDateOf,
  dailyDescriptor,
  decodeShareCode,
  describeDescriptor,
  descriptorKey,
  encodeShareCode,
  MAX_SEED_LENGTH,
  utcDate,
} from './identity.js';
import {
  effectiveFor,
  loadoutLabel,
  moduleDef,
  moduleUnlocked,
  profileLoadout,
  rankIndex,
  rankIndexForXp,
  unlocksBetween,
  type Effective,
} from './equipment.js';
import { distances, frontier, layoutOf, linked, neighbors, nodeById, shortestPath } from './graph.js';
import { objectiveCount, objectiveDone, objectiveLabel, objectiveProgressText, objectiveRoleOf } from './objectives.js';
import { OUTCOME_LABEL, compareRecords, exitQualityFor, recordKey, recordRun, scoreRun } from './results.js';
import { defaultSave, freshTelemetry, migrateSave, sessionProblem } from './persistence.js';
import { EPILOGUE, fmtSeconds, homeBanner, missionBanner, pad, print } from './text.js';
import type {
  Cls,
  DailyAttempt,
  DirSpec,
  EngineEvent,
  FileSpec,
  GameMode,
  Loadout,
  MissionDescriptor,
  MissionResult,
  MissionSpec,
  NodeView,
  OutcomeCounts,
  PendingAction,
  Profile,
  PuzzleState,
  RecordEntry,
  RecordsState,
  SaveBlob,
  SessionSave,
  Settings,
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
  op: 'download' | 'upload';
  nodeId: string;
  dir: DirSpec;
  file: FileSpec;
  path: string;
  progress: number; // 0..1
  seconds: number;
  nextProgressAt: number;
}

interface Cutscene {
  lines: { delay: number; text: string; cls?: Cls }[];
  timer: number;
  then?: () => void;
}

interface Runtime {
  spec: MissionSpec;
  runId: string;
  practice: boolean;
  loadout: Loadout;
  eff: Effective;
  trace: number;
  peakTrace: number;
  /** Active-play seconds since mission start (never time with the app closed). */
  elapsed: number;
  vfs: Map<string, Vfs>;
  cwd: string[];
  currentId: string;
  breached: Set<string>;
  scanned: boolean;
  /** `nodeId|/abs/path` for every file removed by download or rm. */
  pulled: Set<string>;
  downloadedTargets: Set<string>;
  payloadPlaced: boolean;
  vaultLooted: boolean;
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
  pending: { remaining: number; action: PendingAction } | null;
  phase: Phase;
  breakdown: Map<string, number>;
  breakdownComplete: boolean;
  fuseHalf: boolean;
  fuseQuarter: boolean;
  cutscene: Cutscene | null;
  ended: boolean;
  tutorialStep: number;
  firstBreachAt: number | null;
  firstBreachKnown: boolean;
  clueRead: Set<string>;
  objectiveAnnounced: boolean;
  rng: Rng;
}

export interface StorageAdapter {
  /** Raw stored data (any schema version); the engine migrates it. */
  load(): unknown;
  save(blob: SaveBlob): void;
}

export interface GameEngineOptions {
  storage?: StorageAdapter;
  /** Start from this save (any schema version; migrated). */
  save?: unknown;
  /** Test hook: zero out action delays so headless tests tick only what they care about. */
  fast?: boolean;
  /** Injectable clock (telemetry sessions, daily UTC dates, record dates). */
  now?: () => number;
}

let runCounter = 0;

export class GameEngine {
  mode: GameMode = 'boot';
  profile: Profile;
  settings: Settings;
  history: string[] = [];
  records: RecordsState;
  daily: Record<string, DailyAttempt>;
  lastResult: MissionResult | null = null;
  suggest = '';
  /** Notes from loading/migrating the save, shown once at boot. */
  readonly loadNotes: string[];

  private storage: StorageAdapter | undefined;
  private fast: boolean;
  private now: () => number;
  private rt: Runtime | null = null;
  private pendingSession: SessionSave | null = null;
  private brokenSession: SaveBlob['brokenSession'] = null;
  private boot: Cutscene | null = null;
  /** Descriptor + practice of the last started run (share/retry after it ends). */
  private lastStarted: { descriptor: MissionDescriptor; practice: boolean } | null = null;
  /**
   * The engine's single output channel. Delayed actions push events here long
   * after the original submit() returned; submit()/tick() drain it.
   */
  private outbox: EngineEvent[] = [];
  private static specCache = new Map<string, MissionSpec>();

  constructor(opts: GameEngineOptions = {}) {
    this.storage = opts.storage;
    this.fast = opts.fast ?? false;
    this.now = opts.now ?? (() => Date.now());
    const raw = opts.save !== undefined ? opts.save : (this.storage?.load() ?? null);
    const { blob, notes } = migrateSave(raw);
    this.loadNotes = notes;
    this.profile = blob.profile;
    this.settings = blob.settings;
    this.history = blob.history.slice(-100);
    this.records = blob.records;
    this.daily = blob.daily;
    this.pendingSession = blob.session;
    this.brokenSession = blob.brokenSession ?? null;
    this.startBoot();
  }

  /* =============================== public API =============================== */

  submit(line: string): EngineEvent[] {
    const ev = this.outbox;
    const raw = line.trim();
    if (this.mode === 'boot') {
      // Any key skips the boot; a real command typed during it still runs.
      this.skipBoot(ev);
      if (!raw || /^skip(intro)?$/i.test(raw)) return this.drainOutbox();
    }
    if (raw) {
      if (this.history[this.history.length - 1] !== raw) this.history.push(raw);
      if (this.history.length > 100) this.history.shift();
    }
    if (!raw) {
      // F01: on the results screen an EMPTY enter is the one-key retry.
      if (this.mode === 'post') {
        this.cmdRetry(ev);
        ev.push({ t: 'state' });
      }
      return this.drainOutbox();
    }
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
    if (!rt) return this.drainOutbox();
    if (rt.cutscene) {
      this.runCutscene(rt.cutscene, dt, ev);
      return this.drainOutbox();
    }
    if (rt.ended) return this.drainOutbox();
    rt.elapsed += dt;
    if (rt.pending) {
      rt.pending.remaining -= dt;
      if (rt.pending.remaining <= 0) {
        const action = rt.pending.action;
        rt.pending = null;
        this.runPending(rt, action, ev);
      }
    }
    if (rt.ended) return this.drainOutbox();
    if (rt.transfer) {
      this.tickTransfer(rt, dt, ev);
    } else if (!rt.pending) {
      const rate = this.idleRate(rt);
      if (rate > 0) this.addTrace(rt, rate * dt, 'idle', ev);
    }
    if (rt.ended) return this.drainOutbox();
    if (rt.puzzle) this.tickPuzzle(rt, dt, ev);
    if (rt.watchdogNodeId && rt.decoyTimer <= 0) {
      rt.watchdogTimer -= dt;
      if (rt.watchdogTimer <= 0) {
        rt.watchdogTimer = rt.eff.watchdogMoveSeconds;
        this.moveWatchdog(rt, ev);
      }
    }
    if (rt.decoyTimer > 0) {
      rt.decoyTimer = Math.max(0, rt.decoyTimer - dt);
      if (rt.decoyTimer === 0 && rt.watchdogNodeId) {
        ev.push(print('[-] decoy spent — the watchdog is back on your trail.', 'warn'));
        ev.push({ t: 'announce', text: 'Decoy spent. The watchdog is back.' });
        ev.push({ t: 'state' });
      }
    }
    return this.drainOutbox();
  }

  getState(): Snapshot {
    const rt = this.rt;
    const rankIdx = rankIndexForXp(this.profile.xp);
    const next = CONFIG.ranks[rankIdx + 1] ?? null;
    const snap: Snapshot = {
      mode: this.mode,
      prompt: this.prompt(),
      profile: {
        cash: Math.round(this.profile.cash),
        xp: Math.round(this.profile.xp),
        rank: CONFIG.ranks[rankIdx]!.name,
        nextRank: next ? { name: next.name, xp: next.xp } : null,
        contractsDone: this.profile.contractsDone,
        tutorialDone: this.profile.tutorialDone,
        campaignComplete: this.profile.campaignComplete,
        upgrades: { ...this.profile.upgrades },
        equipped: this.profile.equipped,
      },
      settings: { ...this.settings },
      // nothing to suggest while a scan or breach is spinning up — a repeat would only bounce
      suggest: this.rt?.pending ? '' : this.suggest,
      pending: this.pendingSession
        ? { label: describeDescriptor(this.pendingSession.descriptor), trace: Math.floor(this.pendingSession.trace) }
        : null,
      mission: null,
      lastResult: this.lastResult,
    };
    if (rt && (this.mode === 'mission' || this.mode === 'post')) snap.mission = this.missionSnapshot(rt);
    return snap;
  }

  private missionSnapshot(rt: Runtime): NonNullable<Snapshot['mission']> {
    const spec = rt.spec;
    const objState = { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced };
    const layout = layoutOf(spec);
    const targets = spec.nodes.flatMap((n) =>
      walkFiles(n.root)
        .filter((f) => f.tag === 'target' && f.targetId)
        .map((f) => ({ id: f.targetId!, name: f.name, nodeId: n.id, stolen: rt.downloadedTargets.has(f.targetId!) }))
    );
    const { have, need } = objectiveCount(spec.objective, objState);
    const p = rt.puzzle;
    const tr = rt.transfer;
    const obj = spec.objective;
    const optionalLoot = spec.nodes.reduce(
      (acc, n) => acc + this.liveFiles(rt, n.id).filter((f) => f.tag === 'loot').reduce((a, f) => a + (f.value ?? 0), 0),
      0
    );
    return {
      isTutorial: spec.kind === 'tutorial',
      mode: spec.descriptor.mode,
      practice: rt.practice,
      index: spec.index,
      name: spec.name,
      codename: spec.codename,
      seed: formatSeed(spec.descriptor.seed),
      code: encodeShareCode(spec.descriptor),
      trace: Math.floor(rt.trace),
      traceExact: rt.trace,
      peakTrace: Math.floor(rt.peakTrace),
      traceRate: this.currentRate(rt).rate,
      traceSource: this.currentRate(rt).source,
      cleanExitUnder: CONFIG.trace.cleanExitUnder,
      cleanExitAvailable: exitQualityFor(rt.trace) === 'clean',
      phase: rt.phase,
      tools: { ...rt.tools },
      decoyActive: rt.decoyTimer > 0,
      nodes: spec.nodes.map((n) => this.nodeView(rt, n, layout.get(n.id)!)),
      edges: spec.edges.map(([a, b]) => [a, b] as [string, string]),
      currentNodeId: rt.currentId,
      watchdogNodeId: rt.watchdogNodeId,
      targets,
      objective: {
        type: obj.type,
        label: objectiveLabel(spec),
        done: objectiveDone(obj, objState),
        progress: objectiveProgressText(spec, objState),
        payload:
          obj.type === 'payload'
            ? { name: obj.payloadName, host: nodeById(spec, obj.nodeId)?.hostname ?? obj.nodeId, dir: obj.dir, placed: rt.payloadPlaced }
            : undefined,
      },
      modifier: spec.modifier
        ? { id: spec.modifier, name: CONFIG.modifiers[spec.modifier].name, effect: CONFIG.modifiers[spec.modifier].effect, bonus: CONFIG.modifiers[spec.modifier].bonus }
        : null,
      loadoutLabel: loadoutLabel(rt.loadout),
      stolen: have,
      required: need,
      sessionCash: Math.round(rt.sessionCash),
      sessionXp: Math.round(rt.sessionXp),
      logsLeft: spec.nodes.reduce((acc, n) => acc + this.liveFiles(rt, n.id).filter((f) => f.tag === 'log').length, 0),
      optionalLoot,
      puzzle: p
        ? {
            family: p.family,
            familyLabel: FAMILY_LABEL[p.family],
            nodeId: p.nodeId,
            hostname: nodeById(spec, p.nodeId)?.hostname ?? p.nodeId,
            prompt: puzzlePrompt(p),
            timeLeft: Math.max(0, p.timeLimit - p.elapsed),
            timeLimit: p.timeLimit,
            attempts: p.attempts,
            sequenceTerms: p.family === 'sequence' ? [...p.sequence!.terms] : [],
            knockPortsVisible: p.family === 'portknock' ? p.knock!.showLeft > 0 : false,
            knockPorts: p.family === 'portknock' && p.knock!.showLeft > 0 ? [...p.knock!.ports] : [],
            knockEntered: p.knock?.entered.length ?? 0,
            knockLength: p.knock?.ports.length ?? 0,
            memory: p.family === 'portknock' && p.knock!.showLeft <= 0,
            cipherText: p.family === 'cipher' ? (puzzleView(p).cipherText ?? '') : '',
            cipherWheel: p.family === 'cipher' && (p.cipher!.hinted || rt.clueRead.has(p.nodeId)) ? cipherWheel(p.cipher!.shift) : null,
            clueHint: p.family === 'cipher' ? this.clueHint(rt, p.nodeId) : null,
            hintCost: rt.eff.hintCost,
            answerUsage: p.family === 'portknock' ? 'knock <p1> <p2> …' : p.family === 'cipher' ? 'input <word>' : 'input <n>',
          }
        : null,
      transfer: tr
        ? {
            op: tr.op,
            file: tr.file.name,
            pct: Math.floor(tr.progress * 100),
            secondsLeft: Math.max(0, (1 - tr.progress) * tr.seconds),
            traceRate: this.currentRate(rt).rate,
            watched: this.transferWatched(rt),
          }
        : null,
      transferLabel: tr ? tr.file.name : null,
      elapsed: rt.elapsed,
      cutscene: !!rt.cutscene,
    };
  }

  /** Cheap read-only view for the oracle/simulator (getState() builds the whole HUD). */
  probe(): {
    mode: GameMode;
    trace: number;
    peakTrace: number;
    currentNodeId: string | null;
    breached: ReadonlySet<string>;
    lockNodeId: string | null;
    transferring: boolean;
    busy: boolean;
    watchdogNodeId: string | null;
    decoyActive: boolean;
    tools: { proxy: number; decoy: number };
    objectiveDone: boolean;
  } {
    const rt = this.rt;
    return {
      mode: this.mode,
      trace: rt?.trace ?? 0,
      peakTrace: rt?.peakTrace ?? 0,
      currentNodeId: rt?.currentId ?? null,
      breached: rt?.breached ?? new Set<string>(),
      lockNodeId: rt?.puzzle?.nodeId ?? null,
      transferring: !!rt?.transfer,
      busy: !!(rt && (rt.transfer || rt.pending || rt.cutscene)),
      watchdogNodeId: rt?.watchdogNodeId ?? null,
      decoyActive: (rt?.decoyTimer ?? 0) > 0,
      tools: rt ? { ...rt.tools } : { proxy: 0, decoy: 0 },
      objectiveDone: rt ? objectiveDone(rt.spec.objective, { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced }) : false,
    };
  }

  /** TAB completion candidates for the current input state. */
  complete(input: string): { items: string[]; from: number } {
    if (this.mode === 'boot') return { items: [], from: 0 };
    const endsWithSpace = /\s$/.test(input);
    const tokens = input.split(/\s+/);
    const verb = tokens[0]!.toLowerCase();
    const prefix = (tokens[tokens.length - 1] ?? '').toLowerCase();
    const from = input.length - (endsWithSpace ? 0 : (tokens[tokens.length - 1] ?? '').length);
    if (tokens.length <= 1 && !endsWithSpace) {
      const pool = commandsForMode(this.mode === 'post' ? 'post' : this.mode).map((c) => c.name);
      return { items: [...new Set(pool)].filter((n) => n.startsWith(verb)).sort(), from: 0 };
    }
    const argPrefix = endsWithSpace ? '' : prefix;
    const pick = (opts: string[]) => ({ items: opts.filter((o) => o.toLowerCase().startsWith(argPrefix)), from });
    if (verb === 'man' || verb === 'help') return pick(COMMANDS.map((c) => c.name));
    if (verb === 'equip') return pick([...CONFIG.modules.map((m) => m.id), 'none']);
    if (verb === 'buy') return pick(CONFIG.shop.items.map((i) => i.id));
    if (verb === 'settings' && tokens.length <= 2) return pick(['volume', 'mute', 'crt', 'motion', 'typing', 'assist']);
    if (verb === 'daily') return pick(['start']);
    const rt = this.rt;
    if (this.mode === 'mission' && rt) {
      if (['cat', 'cd', 'ls', 'rm', 'download', 'dl', 'get'].includes(verb)) return this.completePath(rt, input, tokens);
      if (verb === 'upload') {
        if (tokens.length === 2 && rt.spec.objective.type === 'payload') return pick([rt.spec.objective.payloadName]);
        return this.completePath(rt, input, [verb, tokens.slice(2).join(' ')]);
      }
      if (verb === 'connect' || verb === 'breach') {
        const items: string[] = [];
        if (rt.scanned) {
          for (const n of rt.spec.nodes) {
            if (!(n.ip.startsWith(argPrefix) || n.hostname.toLowerCase().startsWith(argPrefix))) continue;
            const owned = rt.breached.has(n.id);
            if (verb === 'connect' && owned && n.id !== rt.currentId) items.push(n.ip);
            if (verb === 'breach' && !owned && linked(rt.spec, rt.currentId, n.id)) items.push(n.ip);
          }
        }
        return { items, from };
      }
    }
    return { items: [], from: 0 };
  }

  serialize(): SaveBlob {
    const live = this.rt && this.mode === 'mission' && !this.rt.ended ? this.snapshotSession(this.rt) : null;
    const blob = defaultSave();
    blob.profile = { ...this.profile, upgrades: { ...this.profile.upgrades } };
    blob.settings = { ...this.settings };
    blob.history = this.history.slice(-100);
    // A parked run survives until it is resumed, abandoned, or replaced (F02).
    blob.session = live ?? this.pendingSession;
    blob.records = this.records;
    blob.daily = this.daily;
    blob.brokenSession = this.brokenSession;
    return blob;
  }

  persist(): void {
    this.storage?.save(this.serialize());
  }

  /** Validated mission for a descriptor (cached; the same draw every time). */
  specFor(desc: MissionDescriptor): MissionSpec {
    if (desc.mode === 'tutorial') return tutorialMission();
    const key = descriptorKey(desc);
    let spec = GameEngine.specCache.get(key);
    if (!spec) {
      spec = buildValidatedMission(desc);
      GameEngine.specCache.set(key, spec);
    }
    return spec;
  }

  /** Back-compat: validated spec for (contract index, seed). */
  getValidatedSpec(index: number, seed: string): MissionSpec {
    const desc = seed === contractSeedOf(index) ? campaignDescriptor(index) : customDescriptor(seed, index);
    return this.specFor(desc);
  }

  /** Start a run directly (bypasses the parked-run guard — used by tests and the oracle). */
  startMission(
    spec: MissionSpec,
    ev: EngineEvent[] = this.outbox,
    opts: { loadout?: Loadout; practice?: boolean; resume?: SessionSave } = {}
  ): void {
    const resume = opts.resume ?? null;
    const isDaily = spec.descriptor.mode === 'daily';
    const loadout: Loadout =
      resume?.loadout ??
      opts.loadout ??
      (spec.kind === 'tutorial' ? { module: null, upgrades: {} } : isDaily ? { module: null, upgrades: { ...CONFIG.daily.loadout.upgrades } } : profileLoadout(this.profile));
    const practice = resume?.practice ?? opts.practice ?? false;
    const eff = effectiveFor(loadout, spec.modifier);
    const rng = new Rng(`${spec.draw.seed}::runtime`, resume ? resume.rngState : undefined);
    const vfs = new Map<string, Vfs>();
    for (const n of spec.nodes) vfs.set(n.id, new Vfs(cloneSpecTree(n.root)));
    const rt: Runtime = {
      spec,
      runId: resume?.runId ?? this.newRunId(spec),
      practice,
      loadout,
      eff,
      trace: 0,
      peakTrace: 0,
      elapsed: 0,
      vfs,
      cwd: [],
      currentId: 'n0',
      breached: new Set(['n0']),
      scanned: false,
      pulled: new Set(),
      downloadedTargets: new Set(),
      payloadPlaced: false,
      vaultLooted: false,
      downloadsCount: 0,
      downloadedValue: 0,
      logsWiped: 0,
      sessionCash: 0,
      sessionXp: 0,
      tools: { proxy: eff.proxy, decoy: eff.decoy },
      watchdogNodeId: null,
      watchdogTimer: eff.watchdogMoveSeconds,
      decoyTimer: 0,
      puzzle: null,
      transfer: null,
      pending: null,
      phase: 'quiet',
      breakdown: new Map(),
      breakdownComplete: true,
      fuseHalf: false,
      fuseQuarter: false,
      cutscene: null,
      ended: false,
      tutorialStep: 0,
      firstBreachAt: null,
      firstBreachKnown: false,
      clueRead: new Set(),
      objectiveAnnounced: false,
      rng,
    };
    this.rt = rt;
    this.mode = 'mission';
    this.lastResult = null;
    this.lastStarted = { descriptor: spec.descriptor, practice };

    ev.push({ t: 'clear' });
    this.setSuggest(ev, '');
    ev.push(print(missionBanner(spec, practice), 'banner', 'instant'));
    ev.push(print(`objective: ${objectiveLabel(spec)}`, 'accent'));
    ev.push(print(spec.brief, 'info'));
    if (spec.modifier) {
      const m = CONFIG.modifiers[spec.modifier];
      ev.push(print(`modifier: ${m.name} — ${m.effect}. +$${m.bonus} on completion.`, 'warn'));
    }
    if (spec.kind !== 'tutorial') {
      const dl = CONFIG.trace.downloadPerSecond * eff.transferTraceFactor;
      ev.push(
        print(
          `rig: ${loadoutLabel(loadout)}${isDaily ? ' (daily: fixed stock rig)' : ''} · transfers ${eff.downloadSeconds.toFixed(1)}s @ +${dl.toFixed(1)}/s · fuse +${eff.fuseBonus}s · proxy ×${eff.proxy} · decoy ×${eff.decoy}`,
          'dim'
        )
      );
    }
    if (practice && spec.descriptor.mode === 'daily') {
      ev.push(print('practice run — today\'s recorded attempt is already on file. this one won\'t overwrite it.', 'warn'));
    } else if (practice) {
      ev.push(print('practice run — this contract isn\'t unlocked yet, so it won\'t count toward the campaign.', 'warn'));
    }
    for (const line of spec.handlerLines) ev.push({ t: 'handler', text: line });
    ev.push(print(`\nconnected: ${spec.nodes[0]!.hostname} (${spec.nodes[0]!.ip}) — your foothold. type \`scan\`.`, 'sys'));

    if (resume) {
      this.restoreSession(rt, resume, ev);
    } else {
      if (spec.modifier === 'patrol') this.spawnPatrol(rt, ev);
      if (spec.kind === 'tutorial') {
        const first = TUTORIAL_STEPS[0]!;
        this.setSuggest(ev, first.cmd.join(' '));
        ev.push({ t: 'handler', text: `Next: \`${first.cmd.join(' ')}\` — ${first.note}. TAB fills it.` });
      } else {
        this.countStart(rt);
        if (this.settings.assist) this.setSuggest(ev, 'scan');
      }
      if (isDaily && !practice) {
        const date = dailyDateOf(spec.descriptor)!;
        this.daily[date] = { date, runId: rt.runId, status: 'live' };
        this.trimDaily();
      }
    }
    ev.push({ t: 'sfx', name: 'connect' });
    ev.push({ t: 'announce', text: `Mission started: ${spec.name}. Objective: ${objectiveLabel(spec)}.` });
    ev.push({ t: 'state' });
    // Persist the run start atomically with its daily attempt / identity.
    this.persist();
  }

  private newRunId(spec: MissionSpec): string {
    runCounter = (runCounter + 1) % 1_000_000;
    return `${this.now().toString(36)}-${Rng.hashSeed(`${descriptorKey(spec.descriptor)}#${runCounter}#${Math.random()}`).toString(36)}`;
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
    for (const note of this.loadNotes) ev.push(print(`[i] ${note}`, 'sys'));
    this.homeGreeting(ev);
    ev.push({ t: 'state' });
  }

  private homeGreeting(ev: EngineEvent[]): void {
    if (this.pendingSession) {
      const s = this.pendingSession;
      ev.push(print(`[!] parked run: ${describeDescriptor(s.descriptor)} · trace ${Math.floor(s.trace)}%`, 'warn'));
      ev.push(print('    `resume` to get back on the wire · `abandon` to drop it.', 'warn'));
      ev.push({ t: 'handler', text: 'You left a job running. The meter waited — it was paused while you were gone.' });
      this.setSuggest(ev, 'resume');
      return;
    }
    if (this.brokenSession) {
      ev.push(print(`[!] a parked run (${this.brokenSession.label}) can't be rebuilt: ${this.brokenSession.reason}.`, 'warn'));
      ev.push(print('    `abandon` clears it. nothing else is affected.', 'warn'));
      this.setSuggest(ev, 'abandon');
      return;
    }
    if (!this.profile.tutorialDone) {
      ev.push({ t: 'handler', text: "First job is a warm-up. I'll walk you through it — type `tutorial`." });
      this.setSuggest(ev, 'tutorial');
    } else if (this.profile.campaignComplete && !this.profile.endingSeen) {
      ev.push({ t: 'handler', text: 'Before you pick up anything new — I have one more message for you. `epilogue`.' });
      this.setSuggest(ev, 'epilogue');
    } else {
      ev.push({ t: 'handler', text: this.profile.campaignComplete ? "Board's clear. Daily's fresh — `daily`." : "Back again. Board's live — `contracts`." });
      this.setSuggest(ev, this.profile.campaignComplete ? 'daily' : 'contracts');
    }
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
      cs.then = undefined;
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
        this.printHelp(ev, this.mode);
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
      case 'board':
        this.mode = 'home';
        this.printContracts(ev);
        break;
      case 'run':
        this.cmdRun(args, ev);
        break;
      case 'tutorial':
        this.beginRun(ev, () => this.startMission(tutorialMission(), ev));
        break;
      case 'daily':
        this.cmdDaily(args, ev);
        break;
      case 'retry':
      case 'again':
        this.cmdRetry(ev);
        break;
      case 'share':
        this.cmdShare(ev);
        break;
      case 'records':
      case 'pb':
        this.printRecords(ev);
        break;
      case 'loadout':
      case 'rig':
        this.printLoadout(ev);
        break;
      case 'equip':
        this.cmdEquip(args, ev);
        break;
      case 'unequip':
        this.cmdEquip(['none'], ev);
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
        this.cmdAbandon(ev);
        break;
      case 'epilogue':
      case 'ending':
        this.cmdEpilogue(ev);
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
            telemetry: freshTelemetry(),
            equipped: null,
            campaignComplete: false,
            endingSeen: false,
          };
          this.history = [];
          this.pendingSession = null;
          this.brokenSession = null;
          this.lastResult = null;
          this.lastStarted = null;
          this.records = { best: {}, recent: [] };
          this.daily = {};
          this.mode = 'home';
          this.persist();
          ev.push({ t: 'clear' });
          ev.push(print('[-] burner wiped. day zero. type `tutorial`.', 'warn'));
          this.setSuggest(ev, 'tutorial');
        } else {
          ev.push(print('[!] this erases ALL progression, records and daily attempts. `wipe confirm` to do it.', 'warn'));
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
        const guess = didYouMean(v, this.mode === 'post' ? 'post' : 'home');
        if (/^\d+$/.test(v) && this.mode === 'post') {
          ev.push(print(`[-] '${v}' isn't a command. \`run ${v}\` starts contract ${v}; empty ENTER retries.`, 'bad'));
        } else if (guess) ev.push(print(`[-] unknown verb: '${v}'. did you mean '${guess}'?`, 'bad'));
        else ev.push(print(`[-] unknown verb: '${v}'. type \`help\`.`, 'bad'));
        ev.push({ t: 'sfx', name: 'err' });
      }
    }
    ev.push({ t: 'state' });
  }

  /** The results screen: retry/share are local; everything else is a home verb. */
  private dispatchPost(raw: string, ev: EngineEvent[]): void {
    const v = raw.split(/\s+/)[0]!.toLowerCase();
    if (v === 'home') {
      this.mode = 'home';
      ev.push({ t: 'clear' });
      this.printContracts(ev);
      ev.push({ t: 'state' });
      return;
    }
    this.dispatchHome(raw, ev);
  }

  /** Every way of starting a run goes through here: a parked run is never silently replaced. */
  private beginRun(ev: EngineEvent[], start: () => void): void {
    if (this.pendingSession) {
      const s = this.pendingSession;
      ev.push(print(`[!] a run is parked: ${describeDescriptor(s.descriptor)} (trace ${Math.floor(s.trace)}%).`, 'warn'));
      ev.push(print('    `resume` it, or `abandon` it first — starting another would throw it away.', 'warn'));
      this.setSuggest(ev, 'resume');
      ev.push({ t: 'sfx', name: 'err' });
      return;
    }
    try {
      start();
    } catch (e) {
      if (e instanceof MissionUnavailableError) {
        this.mode = this.mode === 'mission' ? 'home' : this.mode;
        ev.push(print(`[-] the Broker can't build that job: ${e.message}`, 'bad'));
        ev.push(print('    nothing started, nothing charged. try another seed or contract.', 'dim'));
        ev.push({ t: 'sfx', name: 'err' });
        return;
      }
      throw e;
    }
  }

  /* ============================== mission cmds ============================== */

  private dispatchMission(raw: string, ev: EngineEvent[]): void {
    const rt = this.rt!;
    const tokens = raw.split(/\s+/);
    const verb = tokens[0]!.toLowerCase();
    const args = tokens.slice(1);

    if (!this.tutorialGate(rt, verb, args, ev)) return;

    // While a lock is open it owns the terminal — except for read-only looking
    // around (clues!), escape tools, and leaving.
    if (rt.puzzle) {
      const passThrough = [
        'disconnect', 'exit', 'quit', 'logout', 'escape', 'help', '?', 'verbs', 'man', 'clear', 'cls',
        'cat', 'read', 'ls', 'dir', 'cd', 'proxy', 'proxyhop', 'proxy-hop', 'decoy', 'decoy-node',
        'profile', 'status', 'whoami', 'settings', 'config', 'share', 'scan', 'sc', 'recon', 'skipintro',
      ];
      const answerVerbs = ['input', 'answer', 'decode', 'knock', 'skip', 'bypass', 'hint'];
      const bareAnswer = !lookupCommand(verb) && /^[\dA-Za-z]+$/.test(verb);
      if (bareAnswer) {
        this.puzzleAnswer(rt, args.length ? `${verb} ${args.join(' ')}` : verb, ev);
        ev.push({ t: 'state' });
        return;
      }
      if (answerVerbs.includes(verb)) {
        if (verb === 'skip' || verb === 'bypass') this.puzzleSkip(rt, ev);
        else if (verb === 'hint') this.puzzleHintCmd(rt, ev);
        else if (verb === 'knock') this.puzzleKnock(rt, args, ev);
        else this.puzzleAnswer(rt, args.join(' '), ev);
        ev.push({ t: 'state' });
        return;
      }
      if (!passThrough.includes(verb)) {
        const usage = rt.puzzle.family === 'portknock' ? '`knock <ports>`' : '`input <answer>`';
        ev.push(print(`[!] a lock is open — ${usage}, \`hint\`, \`skip\`, \`proxy\`/\`decoy\`, or \`disconnect\`.`, 'warn'));
        return;
      }
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
      case 'crack-node':
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
      case 'upload':
      case 'put':
      case 'plant':
        this.cmdUpload(rt, args, ev);
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
      case 'decoy-node':
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
      case 'verbs':
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
      case 'status':
      case 'whoami':
        this.printProfile(ev);
        break;
      case 'stats':
        this.printStats(ev);
        break;
      case 'settings':
      case 'config':
        this.cmdSettings(args, ev);
        break;
      case 'share':
        this.cmdShare(ev);
        break;
      case 'shop':
      case 'market':
      case 'buy':
        ev.push(print('[-] the market is at home. `disconnect` first — no shopping mid-heist.', 'warn'));
        break;
      case 'equip':
      case 'unequip':
      case 'loadout':
      case 'rig':
        ev.push(print(`[-] the module slot is sealed mid-job. running: ${loadoutLabel(rt.loadout)}.`, 'warn'));
        break;
      case 'skipintro':
        this.cmdSkipIntro(rt, ev);
        break;
      case 'contracts':
      case 'run':
      case 'tutorial':
      case 'resume':
      case 'abandon':
      case 'daily':
      case 'retry':
      case 'records':
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
      ev.push(print('[…] something is already running — hold.', 'dim'));
      return;
    }
    if (rt.puzzle || rt.transfer) {
      // Read-only re-print of what we already know; never delays an open lock.
      if (rt.scanned) this.printScan(rt, ev);
      else ev.push(print('[-] finish what you started — a sweep needs a quiet wire.', 'warn'));
      return;
    }
    ev.push(print('[…] sweeping the network…', 'dim'));
    this.later(rt, this.fast ? 0 : CONFIG.delays.scan, { type: 'scan' });
  }

  private runPending(rt: Runtime, action: PendingAction, ev: EngineEvent[]): void {
    if (rt.ended) return;
    if (action.type === 'scan') {
      rt.scanned = true;
      this.printScan(rt, ev);
      ev.push({ t: 'sfx', name: 'ok' });
      ev.push({ t: 'state' });
      this.tutorialAdvance(rt, 'scan', ev);
      this.coach(rt, ev);
    } else {
      this.openLock(rt, action.nodeId, ev);
    }
  }

  private printScan(rt: Runtime, ev: EngineEvent[]): void {
    const spec = rt.spec;
    ev.push(print(`[+] network mapped — ${spec.nodes.length} nodes, ${spec.edges.length} links. (map: left panel)`, 'good'));
    const layout = layoutOf(spec);
    const order = [...spec.nodes].sort((a, b) => {
      const la = layout.get(a.id)!;
      const lb = layout.get(b.id)!;
      return la.depth - lb.depth || la.lane - lb.lane;
    });
    // columns sized to the widest entry, so a long ip never runs into its hostname
    const ipW = Math.max(...order.map((n) => n.ip.length)) + 2;
    const hostW = Math.max(...order.map((n) => n.hostname.length)) + 2;
    for (const n of order) {
      const owned = rt.breached.has(n.id);
      const here = n.id === rt.currentId;
      const reach = !owned && linked(spec, rt.currentId, n.id);
      const status = n.id === 'n0' ? (here ? 'foothold · you' : 'foothold') : here ? 'you' : owned ? 'owned' : reach ? 'reachable' : 'locked';
      const lock = n.security === 0 ? '' : ` sec${n.security} ${shortFamily(n.puzzleFamily)} · breach +${this.breachCost(rt, n.id)}`;
      const tags: string[] = [];
      if (n.route === 'long') tags.push('long road');
      if (n.route === 'hot') tags.push('hot road');
      if (n.vault) tags.push('VAULT · optional');
      const role = objectiveRoleOf(spec, n.id, { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced });
      if (role === 'target') tags.push('⚑ flagged files');
      if (role === 'dossier') tags.push('⚑ dossier');
      if (role === 'drop') tags.push('⚑ drop point');
      if (rt.watchdogNodeId === n.id) tags.push('⚠ WATCHDOG');
      const cls: Cls = n.id === 'n0' ? 'dim' : reach ? 'accent' : owned ? 'good' : 'info';
      ev.push(print(`  ${pad(n.ip, ipW)}${pad(n.hostname, hostW)}${lock}  [${status}]${tags.length ? ' · ' + tags.join(' · ') : ''}`, cls));
      const extra: string[] = [];
      const loot = this.liveFiles(rt, n.id).filter((f) => f.tag === 'loot' || f.tag === 'target').reduce((a, f) => a + (f.value ?? 0), 0);
      if (loot > 0) extra.push(`loot ~$${loot}`);
      const logs = this.liveFiles(rt, n.id).filter((f) => f.tag === 'log').length;
      if (logs) extra.push(`${logs} log`);
      const clue = this.clueHint(rt, n.id);
      if (clue && !owned) extra.push(`cipher tag: ${clue}`);
      const links = neighbors(spec, n.id).map((id) => nodeById(spec, id)!.hostname);
      extra.push(`links ${links.join(', ')}`);
      ev.push(print(`      ${extra.join(' · ')}`, 'dim'));
    }
    if (spec.descriptor.topology === 'fork') {
      ev.push(print('two approaches meet at the junction — more soft locks, or one hot one. your call.', 'dim'));
    } else {
      ev.push(print('deeper nodes pay more and burn more trace. the route is your call.', 'dim'));
    }
  }

  private cmdConnect(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    const target = this.resolveNode(rt, args.join(' '));
    if (!target) {
      ev.push(print(`[-] no node '${args.join(' ')}' on this network. \`scan\` first?`, 'bad'));
      return;
    }
    if (target.id === rt.currentId) {
      ev.push(print('[-] already on it.', 'dim'));
      return;
    }
    if (!rt.breached.has(target.id)) {
      ev.push(print(`[-] ${target.ip} is still locked. \`breach ${target.ip}\` from a linked node.`, 'bad'));
      return;
    }
    if (rt.transfer) {
      ev.push(print('[!] transfer in flight — hopping would drop it. wait it out.', 'warn'));
      return;
    }
    rt.currentId = target.id;
    rt.cwd = [];
    this.addTrace(rt, CONFIG.trace.connectHop, 'connect', ev);
    ev.push(print(`[+] session moved to ${target.hostname} (${target.ip}). trace +${CONFIG.trace.connectHop}`, 'good'));
    ev.push({ t: 'sfx', name: 'connect' });
    this.coach(rt, ev);
  }

  private cmdBreach(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    if (rt.pending) {
      ev.push(print('[…] something is already running — hold.', 'dim'));
      return;
    }
    if (!args.length) {
      const reachable = neighbors(rt.spec, rt.currentId)
        .map((id) => nodeById(rt.spec, id)!)
        .filter((n) => !rt.breached.has(n.id));
      if (!reachable.length) {
        const elsewhere = frontier(rt.spec, rt.breached);
        if (elsewhere.length) {
          const via = this.ownedNeighborOf(rt, elsewhere[0]!);
          ev.push(print(`[-] nothing to breach from here. \`connect ${via?.ip ?? ''}\` (${via?.hostname ?? '?'}) borders a locked node.`, 'warn'));
          if (via) this.setSuggest(ev, `connect ${via.ip}`);
        } else {
          ev.push(print('[-] every node is yours. finish the job and `disconnect`.', 'warn'));
        }
        return;
      }
      ev.push(print('[?] breach which node? from here you can reach:', 'warn'));
      for (const n of reachable) {
        ev.push(
          print(
            `    breach ${n.ip}   (${n.hostname}${rt.scanned ? `, sec ${n.security}, +${this.breachCost(rt, n.id)} trace${n.vault ? ', VAULT' : ''}` : ''})`,
            'accent'
          )
        );
      }
      this.setSuggest(ev, `breach ${reachable[0]!.ip}`);
      return;
    }
    const target = this.resolveNode(rt, args.join(' '));
    if (!target) {
      ev.push(print(`[-] no node '${args.join(' ')}' on this network. \`scan\` lists the ips — hostnames work too.`, 'bad'));
      return;
    }
    if (rt.breached.has(target.id)) {
      ev.push(print(target.id === rt.currentId ? '[-] you\'re standing on it.' : `[-] already owned. \`connect ${target.ip}\` to hop there.`, 'dim'));
      return;
    }
    if (!linked(rt.spec, rt.currentId, target.id)) {
      const via = this.ownedNeighborOf(rt, target.id);
      if (via) {
        ev.push(print(`[-] no direct link from here. ${via.hostname} borders it — \`connect ${via.ip}\` first (+${CONFIG.trace.connectHop} trace).`, 'bad'));
        this.setSuggest(ev, `connect ${via.ip}`);
      } else {
        ev.push(print('[-] no route yet — that node sits deeper in. breach your way toward it.', 'bad'));
      }
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
    // The old suggestion is about to be wrong — drop it during spin-up.
    this.setSuggest(ev, '');
    this.later(rt, this.fast ? 0 : CONFIG.delays.breachSpinUp, { type: 'breach', nodeId: target.id });
  }

  private openLock(rt: Runtime, nodeId: string, ev: EngineEvent[]): void {
    const target = nodeById(rt.spec, nodeId);
    if (!target || rt.breached.has(nodeId)) return;
    const sec = target.security as 1 | 2 | 3;
    const timeLimit = CONFIG.puzzle.timeBoxBySecurity[sec]! + rt.eff.fuseBonus;
    rt.puzzle = instantiatePuzzle(rt.spec.puzzleAnswers[target.id]!, target.id, sec, timeLimit, rt.spec.kind === 'tutorial');
    rt.fuseHalf = false;
    rt.fuseQuarter = false;
    if (rt.spec.kind === 'contract') this.profile.telemetry.locksEncountered++;
    ev.push(print(`[!] firewall lock engaged — ${FAMILY_LABEL[rt.puzzle.family]} · fuse ${timeLimit}s:`, 'warn'));
    ev.push(print('    ' + puzzlePrompt(rt.puzzle), 'accent', 'instant'));
    if (rt.puzzle.family === 'sequence') {
      ev.push(print('    (four terms, one rule — `input <next number>` · `man breach` lists the rules)', 'dim'));
    } else if (rt.puzzle.family === 'portknock') {
      ev.push(print('    (memorize the glow — then `knock <p1> <p2> ...` from memory, or one port at a time)', 'dim'));
    } else {
      const clue = this.clueHint(rt, target.id);
      if (rt.clueRead.has(target.id)) {
        ev.push(print('    (you already have this wheel — decoding strip is on your lock panel. `input <word>`)', 'dim'));
      } else if (clue) {
        ev.push(print(`    (wheel tag: ${clue} — \`cat\` works while the lock is open. then \`input <word>\`)`, 'dim'));
      } else {
        ev.push(print('    (decode the Caesar shift — `input <word>` · `hint` buys the offset)', 'dim'));
      }
    }
    ev.push(print('    escape hatches: `hint` · `skip` (+25) · `proxy` · `decoy` · `disconnect`', 'dim'));
    ev.push({ t: 'puzzleOpen', puzzle: puzzleView(rt.puzzle) });
    ev.push({ t: 'announce', text: `Lock open on ${target.hostname}: ${FAMILY_LABEL[rt.puzzle.family]}, ${timeLimit} second fuse.` });
    ev.push({ t: 'state' });
    this.tutorialAdvance(rt, 'breach', ev);
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
      this.tutorialAdvance(rt, 'ls', ev);
      return;
    }
    for (const d of listing.dirs) ev.push(print(`  ${pad(d + '/', 26)}<dir>`, 'accent'));
    for (const f of listing.files) {
      const note =
        f.tag === 'target'
          ? `LOOT $${f.value} · TARGET`
          : f.tag === 'loot'
            ? `LOOT $${f.value}`
            : f.tag === 'log'
              ? 'LOG — rm buys trace margin'
              : f.tag === 'payload'
                ? 'PLANTED — your payload'
                : f.clueFor
                  ? 'cipher wheel tag — cat it'
                  : '';
      const cls: Cls = f.tag === 'target' || f.tag === 'loot' ? 'loot' : f.tag === 'log' ? 'log' : f.clueFor ? 'accent' : 'dim';
      ev.push(print(`  ${pad(f.name, 26)}${note}`, cls));
    }
    this.tutorialAdvance(rt, 'ls', ev);
  }

  private cmdCd(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    const path = args.join(' ');
    if (!path) {
      rt.cwd = [];
      ev.push(print('cwd: /', 'sys'));
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
    const arg = args.join(' ');
    const hit = this.currentVfs(rt).resolveFile(arg, rt.cwd);
    if (!hit) {
      const elsewhere = locateFileOnNode(this.currentVfs(rt).rootDir, arg.split('/').pop() ?? arg);
      if (elsewhere) {
        ev.push(print(`[-] not in this directory — it's at ${elsewhere}.`, 'warn'));
      } else {
        const guess = suggestFile(this.currentVfs(rt), rt.cwd, arg);
        ev.push(print(`[-] no such file: ${arg}${guess ? ` — did you mean '${guess}'?` : ''}`, 'bad'));
      }
      return;
    }
    const f = hit.file;
    if (f.tag === 'loot' || f.tag === 'target') {
      ev.push(print(`[##] ${f.name}: binary blob, encrypted payload ($${f.value}${f.tag === 'target' ? ' · TARGET' : ''}).`, 'loot'));
      ev.push(print('     it only matters once it is on your rig — `download` it.', 'dim'));
      return;
    }
    if (f.tag === 'payload') {
      ev.push(print(`[##] ${f.name}: your payload, humming quietly. leave it be.`, 'loot'));
      return;
    }
    for (const line of (f.content ?? '(corrupted — nothing readable)').split('\n')) {
      ev.push(print('  ' + line, f.tag === 'log' ? 'log' : f.clueFor ? 'accent' : 'info', 'instant'));
    }
    if (f.tag === 'log') ev.push(print('  (this log is hot — `rm` it to clear trace)', 'warn'));
    if (f.clueFor && !rt.clueRead.has(f.clueFor)) {
      rt.clueRead.add(f.clueFor);
      const host = nodeById(rt.spec, f.clueFor)?.hostname ?? f.clueFor;
      ev.push(print(`[+] wheel noted for ${host} — the decoding strip now rides on your lock panel.`, 'good'));
      ev.push({ t: 'sfx', name: 'hint' });
      ev.push({ t: 'state' });
    }
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
        ev.push(print(`[-] not in this directory — it's at ${elsewhere}. \`download ${elsewhere}\` works from anywhere.`, 'warn'));
        this.setSuggest(ev, `download ${elsewhere}`);
      } else {
        const guess = suggestFile(this.currentVfs(rt), rt.cwd, path);
        ev.push(print(`[-] no such file: ${path}${guess ? ` — did you mean '${guess}'?` : ''}`, 'bad'));
      }
      return;
    }
    if (hit.file.tag !== 'loot' && hit.file.tag !== 'target') {
      ev.push(print(hit.file.tag === 'payload' ? '[-] that\'s your own payload. it stays.' : '[-] nothing worth the noise. loot files only.', 'bad'));
      return;
    }
    const seconds = rt.eff.downloadSeconds;
    rt.transfer = {
      op: 'download',
      nodeId: rt.currentId,
      dir: hit.dir,
      file: hit.file,
      path: absPathOf(rt.cwd, path),
      progress: 0,
      seconds,
      nextProgressAt: 0.05,
    };
    const rate = this.currentRate(rt).rate;
    ev.push(
      print(
        `[»] transferring ${hit.file.name} ($${hit.file.value}${hit.file.tag === 'target' ? ' · TARGET' : ''}) — ${seconds.toFixed(1)}s at +${rate.toFixed(1)} trace/s${this.transferWatched(rt) ? ' (watchdog ×2!)' : ''}`,
        'loot'
      )
    );
    ev.push({ t: 'sfx', name: 'breachStart' });
    this.setSuggest(ev, '');
  }

  private cmdUpload(rt: Runtime, args: string[], ev: EngineEvent[]): void {
    const obj = rt.spec.objective;
    if (obj.type !== 'payload') {
      ev.push(print('[-] nothing to upload — this job has no payload.', 'bad'));
      return;
    }
    if (rt.payloadPlaced) {
      ev.push(print('[-] the payload is already planted. once is the job; twice is a signature.', 'warn'));
      return;
    }
    if (rt.transfer) {
      ev.push(print('[!] transfer already running — hold.', 'warn'));
      return;
    }
    if (rt.pending) {
      ev.push(print('[…] something is already running — hold.', 'dim'));
      return;
    }
    const [name, ...rest] = args;
    if (name && name.toLowerCase() !== obj.payloadName.toLowerCase()) {
      ev.push(print(`[-] your rig only carries ${obj.payloadName}. \`upload ${obj.payloadName}\`.`, 'bad'));
      return;
    }
    const dropHost = nodeById(rt.spec, obj.nodeId)!;
    if (rt.currentId !== obj.nodeId) {
      ev.push(print(`[-] wrong box — the drop point is ${obj.dir} on ${dropHost.hostname}.`, 'bad'));
      return;
    }
    const destArg = rest.join(' ');
    const destParts = destArg
      ? normalizeParts(destArg.startsWith('/') ? Vfs.splitPath(destArg) : [...rt.cwd, ...Vfs.splitPath(destArg)])
      : rt.cwd;
    const dest = '/' + destParts.join('/');
    if (dest !== obj.dir) {
      ev.push(print(`[-] not here — the drop point is ${obj.dir}. \`upload ${obj.payloadName} ${obj.dir}\` works from anywhere on this box.`, 'warn'));
      this.setSuggest(ev, `upload ${obj.payloadName} ${obj.dir}`);
      return;
    }
    const dirSpec = this.currentVfs(rt).resolveDir(obj.dir, []);
    if (!dirSpec) {
      ev.push(print(`[-] the drop point ${obj.dir} is gone. that should not happen.`, 'bad'));
      return;
    }
    const seconds = rt.eff.uploadSeconds;
    rt.transfer = {
      op: 'upload',
      nodeId: rt.currentId,
      dir: dirSpec,
      file: { name: obj.payloadName, tag: 'payload' },
      path: `${obj.dir}/${obj.payloadName}`,
      progress: 0,
      seconds,
      nextProgressAt: 0.05,
    };
    const rate = this.currentRate(rt).rate;
    ev.push(print(`[«] uploading ${obj.payloadName} → ${obj.dir} — ${seconds.toFixed(1)}s at +${rate.toFixed(1)} trace/s`, 'loot'));
    ev.push({ t: 'sfx', name: 'breachStart' });
    this.setSuggest(ev, '');
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
        ev.push(print(`[-] not in this directory — it's at ${elsewhere}. \`rm ${elsewhere}\` works from anywhere.`, 'warn'));
        this.setSuggest(ev, `rm ${elsewhere}`);
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
    if (hit.file.tag === 'payload') {
      ev.push(print('[-] that\'s the payload you came to plant. leave it.', 'warn'));
      return;
    }
    if (rt.transfer && rt.transfer.dir === hit.dir && rt.transfer.file === hit.file) {
      ev.push(print('[-] that file is mid-transfer.', 'warn'));
      return;
    }
    const abs = absPathOf(rt.cwd, path);
    this.currentVfs(rt).removeFile(path, rt.cwd);
    rt.pulled.add(`${rt.currentId}|${abs}`);
    if (hit.file.tag === 'log') {
      rt.logsWiped++;
      this.addTrace(rt, CONFIG.trace.rmLog, 'log-wipe', ev);
      ev.push(print(`[+] tracks cleared: ${hit.file.name} — trace ${CONFIG.trace.rmLog}`, 'good'));
      ev.push({ t: 'sfx', name: 'ok' });
      ev.push({ t: 'flash', kind: 'good' });
      this.tutorialAdvance(rt, 'rm-log', ev);
      this.coach(rt, ev);
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
    if (rt.trace <= 0) {
      ev.push(print('[-] trace is already zero. save the relay.', 'warn'));
      return;
    }
    rt.tools.proxy--;
    if (rt.spec.kind === 'contract') this.profile.telemetry.proxiesBurned++;
    this.addTrace(rt, -CONFIG.tools.proxyHopReduction, 'proxy-hop', ev);
    ev.push(print(`[+] proxy hop — tunnel rerouted through a burner. trace −${CONFIG.tools.proxyHopReduction}`, 'good'));
    if (rt.puzzle) ev.push(print('    (the lock is still open — fuse and knocks untouched.)', 'dim'));
    ev.push({ t: 'sfx', name: 'ok' });
    ev.push({ t: 'flash', kind: 'good' });
  }

  private cmdDecoy(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.tools.decoy <= 0) {
      ev.push(print('[-] no decoys left this job.', 'bad'));
      return;
    }
    if (!rt.watchdogNodeId) {
      ev.push(print('[-] nothing is hunting you yet. save it.', 'warn'));
      return;
    }
    if (rt.decoyTimer > 0) {
      ev.push(print('[-] the watchdog is already chewing on a decoy.', 'warn'));
      return;
    }
    rt.tools.decoy--;
    if (rt.spec.kind === 'contract') this.profile.telemetry.decoysBurned++;
    rt.decoyTimer = CONFIG.tools.decoyOccupySeconds;
    const dist = distances(rt.spec, rt.currentId);
    const far = rt.spec.nodes
      .filter((n) => n.id !== 'n0')
      .sort((a, b) => (dist.get(b.id) ?? 0) - (dist.get(a.id) ?? 0) || a.id.localeCompare(b.id))[0]!;
    rt.watchdogNodeId = far.id;
    ev.push(print(`[+] decoy lit — watchdog diverted to ${far.hostname} for ~${CONFIG.tools.decoyOccupySeconds}s.`, 'good'));
    if (rt.puzzle) ev.push(print('    (the lock is still open — fuse and knocks untouched.)', 'dim'));
    ev.push({ t: 'sfx', name: 'ok' });
    ev.push({ t: 'announce', text: `Decoy lit. Watchdog diverted to ${far.hostname}.` });
    ev.push({ t: 'state' });
  }

  private cmdDisconnect(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.transfer) {
      ev.push(print(`[-] ${rt.transfer.op} aborted mid-flight — that file stays behind.`, 'bad'));
      rt.transfer = null;
    }
    if (rt.puzzle) {
      rt.puzzle = null;
      ev.push({ t: 'puzzleClose' });
      ev.push(print('you slice the tunnel mid-lock.', 'dim'));
    }
    rt.pending = null;
    const result = this.settleRun(rt, 'disconnect');
    this.presentResult(rt, result, ev);
  }

  private cmdSkipIntro(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.spec.kind !== 'tutorial') {
      ev.push(print('no intro to skip mid-contract. `disconnect` ends the run.', 'dim'));
      return;
    }
    rt.ended = true;
    this.rt = null;
    this.mode = 'home';
    this.profile.tutorialDone = true;
    this.persist();
    ev.push({ t: 'clear' });
    ev.push(print('[-] tutorial skipped. `contracts` for the board — `run 1` is open.', 'warn'));
    this.setSuggest(ev, 'contracts');
  }

  /* -------------------------------- puzzles -------------------------------- */

  private puzzleAnswer(rt: Runtime, raw: string, ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    if (!raw.trim()) {
      ev.push(print(`[-] ${p.family === 'cipher' ? 'input a word' : p.family === 'portknock' ? 'knock some ports' : 'input a number'}.`, 'bad'));
      return;
    }
    if (p.family === 'portknock') {
      const ports = raw.trim().split(/[\s,]+/);
      if (ports.every((x) => /^\d+$/.test(x))) {
        if (ports.length === 1) this.puzzleKnockStep(rt, ports[0]!, ev);
        else this.puzzleKnock(rt, ports, ev);
        return;
      }
    }
    p.attempts++;
    const forced = p.forcedSuccess && p.attempts === 1;
    let grade: Grade;
    if (forced) grade = 'correct';
    else if (p.family === 'sequence') grade = gradeSequence(p, raw);
    else if (p.family === 'cipher') grade = gradeCipher(p, raw);
    else grade = 'wrong';
    if (grade === 'correct') {
      if (forced && rt.spec.kind === 'tutorial') {
        ev.push(print("(the lock was pre-disarmed for you. you're welcome.)", 'dim'));
        const seq = p.sequence;
        if (seq) {
          ev.push(print(`(the trick: ${seq.terms.join(' · ')} — each term ×2, and 8 × 2 = ${seq.answer}. \`man breach\` lists every rule.)`, 'dim'));
        }
      }
      this.breachSuccess(rt, ev);
    } else if (p.family === 'sequence') {
      this.puzzleFail(rt, ev, `[-] ${raw.trim()} rejected — the pattern disagrees.`);
    } else if (p.family === 'portknock') {
      this.puzzleFail(rt, ev, '[-] that is not a port. `knock <p1> <p2> ...`.');
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
    if (ports.length === 1) {
      this.puzzleKnockStep(rt, String(ports[0]), ev);
      return;
    }
    p.attempts++;
    // A full sequence after partial single knocks continues from the buffer.
    const full = p.knock!.entered.length && ports.length === p.knock!.ports.length - p.knock!.entered.length
      ? [...p.knock!.entered, ...ports]
      : ports;
    if (gradeKnock(p, full) === 'correct') {
      this.breachSuccess(rt, ev);
    } else {
      p.knock!.entered = [];
      this.puzzleFail(rt, ev, '[-] sequence refused — the buffer trips. from the top.');
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
      if (p.knock!.entered.length === want.length) this.breachSuccess(rt, ev);
    } else {
      p.knock!.entered = [];
      this.puzzleFail(rt, ev, `[-] port ${port} refused${got > 0 ? ` after ${got} good knock${got === 1 ? '' : 's'}` : ''} — buffer resets.`);
    }
    this.tutorialAdvance(rt, 'input', ev);
  }

  private puzzleFail(rt: Runtime, ev: EngineEvent[], message: string): void {
    const fam = rt.puzzle?.family;
    ev.push(print(message, 'bad'));
    if (rt.spec.kind === 'contract') {
      this.profile.telemetry.lockFailures++;
      if (fam) this.profile.telemetry.failuresByFamily[fam] = (this.profile.telemetry.failuresByFamily[fam] ?? 0) + 1;
    }
    ev.push({ t: 'sfx', name: 'err' });
    ev.push({ t: 'shake', power: 0.6 });
    this.addTrace(rt, CONFIG.trace.failedPuzzle, 'puzzle-fail', ev);
  }

  private puzzleSkip(rt: Runtime, ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    rt.puzzle = null;
    ev.push({ t: 'puzzleClose' });
    ev.push(print(`[+] lock bypassed — brute force, ugly, effective. trace +${CONFIG.trace.skipPuzzle}.`, 'warn'));
    ev.push({ t: 'sfx', name: 'skip' });
    if (rt.spec.kind === 'contract') this.profile.telemetry.locksSkipped++;
    this.addTrace(rt, CONFIG.trace.skipPuzzle, 'skip', ev);
    if (rt.ended) return;
    this.breachOpenNode(rt, p.nodeId, ev);
  }

  private puzzleHintCmd(rt: Runtime, ev: EngineEvent[]): void {
    const p = rt.puzzle!;
    const cost = rt.eff.hintCost;
    if (p.family === 'cipher' && p.cipher!.hinted) {
      ev.push(print(puzzleHint(p), 'accent'));
      ev.push(print('(already paid for — no charge.)', 'dim'));
      return;
    }
    if (this.profile.cash < cost) {
      ev.push(print(`[-] consulting fee is $${cost}. you're broke. \`skip\` is free (in trace).`, 'warn'));
      return;
    }
    this.profile.cash -= cost;
    if (rt.spec.kind === 'contract') this.profile.telemetry.hintsBought++;
    if (p.family === 'cipher') p.cipher!.hinted = true;
    if (p.family === 'portknock') p.knock!.showLeft = CONFIG.puzzle.knockHintShowSeconds;
    ev.push(print(puzzleHint(p), 'accent'));
    if (p.family === 'portknock') ev.push(print('    ' + puzzlePrompt(p), 'accent', 'instant'));
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
        ev.push(print('· · · ports dark · · ·  memory challenge: `knock <p1> <p2> ...`', 'warn'));
        ev.push({ t: 'puzzleOpen', puzzle: puzzleView(p) });
        ev.push({ t: 'announce', text: 'Ports dark. Repeat the knock sequence from memory.' });
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
      ev.push({ t: 'announce', text: `Fuse burning: ${Math.ceil(Math.max(0, left))} seconds.` });
      ev.push({ t: 'glitch' });
    }
    if (left <= 0) {
      const burnedNode = nodeById(rt.spec, p.nodeId)!;
      rt.puzzle = null;
      ev.push({ t: 'puzzleClose' });
      ev.push(print('[−] the fuse burned. the lock re-arms itself.', 'bad'));
      if (rt.spec.kind === 'contract') {
        this.profile.telemetry.lockFailures++;
        this.profile.telemetry.failuresByFamily[p.family] = (this.profile.telemetry.failuresByFamily[p.family] ?? 0) + 1;
      }
      ev.push({ t: 'sfx', name: 'err' });
      this.addTrace(rt, CONFIG.trace.failedPuzzle, 'puzzle-fail', ev);
      if (rt.ended) return;
      ev.push(print(`    \`breach ${burnedNode.ip}\` to try again — or route around it.`, 'dim'));
      if (rt.spec.kind === 'tutorial') {
        this.tutorialRewind(rt, 'breach', ev);
      } else {
        this.setSuggest(ev, `breach ${burnedNode.ip}`);
        ev.push({ t: 'handler', text: `Lock's re-armed. Go again: \`breach ${burnedNode.ip}\`.` });
      }
      ev.push({ t: 'state' });
    }
  }

  private breachSuccess(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.spec.kind === 'contract') this.profile.telemetry.locksSolved++;
    this.breachOpenNode(rt, rt.puzzle!.nodeId, ev);
  }

  /** The shared "this node falls" path for solved locks and skips. */
  private breachOpenNode(rt: Runtime, nodeId: string, ev: EngineEvent[]): void {
    const node = nodeById(rt.spec, nodeId)!;
    if (rt.firstBreachAt === null && !rt.firstBreachKnown && rt.spec.kind === 'contract') {
      rt.firstBreachAt = rt.elapsed;
      rt.firstBreachKnown = true;
    }
    const cost = this.breachCost(rt, nodeId);
    const watched = rt.watchdogNodeId === nodeId && rt.decoyTimer <= 0;
    if (watched) {
      ev.push(print('[!!] the watchdog watched you do that — breach cost DOUBLED.', 'bad'));
      ev.push({ t: 'glitch' });
    }
    if (rt.puzzle) {
      rt.puzzle = null;
      ev.push({ t: 'puzzleClose' });
    }
    rt.breached.add(nodeId);
    rt.currentId = nodeId;
    rt.cwd = [];
    rt.sessionXp += CONFIG.economy.xpPerNode;
    ev.push(print(`[+] ACCESS GRANTED — ${node.hostname} is yours.${cost > 0 ? ` (trace +${cost})` : ''}`, 'good'));
    ev.push({ t: 'sfx', name: 'breachHit' });
    ev.push({ t: 'flash', kind: 'good' });
    ev.push({ t: 'announce', text: `Access granted: ${node.hostname}.` });
    if (cost > 0) this.addTrace(rt, cost, watched ? 'breach-watchdog' : 'breach', ev);
    if (rt.ended) return;
    const role = objectiveRoleOf(rt.spec, nodeId, { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced });
    const files = this.liveFiles(rt, nodeId);
    if (role === 'target' || role === 'dossier') {
      const paths = this.targetPathsOn(rt, nodeId);
      ev.push(print(`    objective here: ${paths.join(', ')} — \`download\` it.`, 'loot'));
    } else if (role === 'drop' && rt.spec.objective.type === 'payload') {
      ev.push(print(`    drop point here: ${rt.spec.objective.dir} — \`upload ${rt.spec.objective.payloadName} ${rt.spec.objective.dir}\`.`, 'loot'));
    }
    const greed = files.filter((f) => f.tag === 'loot');
    if (greed.length) {
      // name the paths: greed should cost a decision and trace, not a round of `ls`
      const where = greed.slice(0, 3).map((f) => this.pathOf(rt, nodeId, f));
      const more = greed.length > where.length ? ` +${greed.length - where.length} more` : '';
      ev.push(print(`    optional loot (~$${greed.reduce((a, f) => a + (f.value ?? 0), 0)})${node.vault ? ' — VAULT' : ''}: ${where.join(' · ')}${more}`, 'loot'));
    }
    const logs = files.filter((f) => f.tag === 'log').length;
    if (logs > 0) ev.push(print(`    logs here: ${logs} — \`rm\` buys trace margin.`, 'log'));
    const clues = files.filter((f) => f.clueFor && !rt.breached.has(f.clueFor));
    for (const c of clues) ev.push(print(`    cipher wheel tag: ${this.pathOf(rt, nodeId, c)} (for ${nodeById(rt.spec, c.clueFor!)?.hostname})`, 'accent'));
    this.checkObjective(rt, ev);
    this.coach(rt, ev);
    ev.push({ t: 'state' });
  }

  /* --------------------------------- trace --------------------------------- */

  private addTrace(rt: Runtime, delta: number, cause: TraceCause, ev: EngineEvent[]): void {
    if (rt.ended) return;
    const cap = rt.spec.kind === 'tutorial' ? CONFIG.trace.tutorialCap : CONFIG.escalation.bustedAt;
    const before = rt.trace;
    rt.trace = Math.max(0, Math.min(cap, rt.trace + delta));
    rt.peakTrace = Math.max(rt.peakTrace, rt.trace);
    const applied = rt.trace - before;
    if (applied !== 0) {
      rt.breakdown.set(cause, (rt.breakdown.get(cause) ?? 0) + applied);
      ev.push({ t: 'trace', value: Math.floor(rt.trace), delta: Math.round(applied * 10) / 10, cause });
    }
    const phase = phaseFor(rt.trace);
    if (phase !== rt.phase) this.enterPhase(rt, rt.phase, phase, ev);
    if (rt.trace >= CONFIG.escalation.bustedAt && rt.spec.kind !== 'tutorial') this.startBusted(rt, ev);
  }

  private enterPhase(rt: Runtime, prev: Phase, next: Phase, ev: EngineEvent[]): void {
    rt.phase = next;
    const strength = (p: Phase) => (p === 'quiet' ? 0 : p === 'watchdog' ? 1 : 2);
    if (strength(next) > strength(prev)) {
      if (next === 'watchdog' || (next === 'alert' && prev === 'quiet')) {
        if (!rt.watchdogNodeId) {
          const candidates = rt.spec.nodes.filter((n) => n.id !== 'n0');
          rt.watchdogNodeId = rt.rng.pick(candidates).id;
          rt.watchdogTimer = rt.eff.watchdogMoveSeconds;
          ev.push(print('[!!] TRACE 50% — WATCHDOG DAEMON spawned. it patrols the links;', 'bad'));
          ev.push(print('     breaching (or transferring) where it sits costs double. `decoy` buys time.', 'bad'));
          ev.push({ t: 'handler', text: "Watchdog's up. Watch the map — work around it." });
        } else {
          ev.push(print('[!!] TRACE 50% — the watchdog has your scent. clean exit is gone.', 'bad'));
        }
        ev.push({ t: 'sfx', name: 'alarm' });
        ev.push({ t: 'shake', power: 0.5 });
        ev.push({ t: 'announce', text: 'Trace 50 percent. Watchdog active. Clean exit lost.' });
      }
      if (next === 'alert') {
        ev.push(print('[!!] TRACE 75% — ADMIN ALERT. creep is doubled. the room is red.', 'bad'));
        ev.push(print('     finish it, `proxy`, or be gone. NOW.', 'bad'));
        ev.push({ t: 'sfx', name: 'alarm' });
        ev.push({ t: 'glitch' });
        ev.push({ t: 'shake', power: 1 });
        ev.push({ t: 'handler', text: "That pulse in your eyes? That's an admin alert. Move." });
        ev.push({ t: 'announce', text: 'Trace 75 percent. Admin alert. Idle creep doubled.' });
      }
    } else {
      if (next === 'watchdog') {
        ev.push(print('[+] admin alert cleared — creep back to baseline. the watchdog is still out there.', 'good'));
        ev.push({ t: 'announce', text: 'Admin alert cleared.' });
      } else if (next === 'quiet') {
        if (rt.spec.modifier !== 'patrol') {
          rt.watchdogNodeId = null;
          ev.push(print('[+] trace cooled below 50% — the watchdog loses interest and drops away. clean exit is back.', 'good'));
        } else {
          ev.push(print('[+] trace cooled below 50% — clean exit is back. the patrol keeps walking.', 'good'));
        }
        ev.push({ t: 'sfx', name: 'ok' });
        ev.push({ t: 'announce', text: 'Trace below 50 percent. Clean exit available.' });
      }
    }
    ev.push({ t: 'state' });
  }

  private startBusted(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.cutscene || rt.ended) return;
    const tracePct = Math.floor(rt.trace);
    rt.transfer = null;
    rt.pending = null;
    if (rt.puzzle) {
      rt.puzzle = null;
      ev.push({ t: 'puzzleClose' });
    }
    // Score immediately: a closed tab mid-cutscene must not lose or replay the outcome.
    const result = this.settleRun(rt, 'busted');
    const lines = [
      { delay: 0.05, text: '[!!] TRACE 100% — COUNTER-TRACE LOCKS ON', cls: 'bad' as Cls },
      { delay: 0.8, text: '     ▓▓ your tunnel folds like a paper tower ▓▓', cls: 'warn' as Cls },
      { delay: 0.8, text: '     someone severs the session mid-byte.', cls: 'warn' as Cls },
      { delay: 0.9, text: `"Trace was at ${tracePct}%. so close." — the Broker`, cls: 'handler' as Cls },
      { delay: 0.6, text: '[−] BUSTED — mission loot lost · XP halved', cls: 'bad' as Cls },
    ];
    rt.cutscene = {
      lines: lines.slice(1),
      timer: this.fast ? 0 : lines[0]!.delay,
      then: () => {
        rt.cutscene = null;
        this.presentResult(rt, result, this.outbox);
      },
    };
    if (this.fast) rt.cutscene.lines.forEach((l) => (l.delay = 0));
    ev.push(print(lines[0]!.text, lines[0]!.cls, 'instant'));
    ev.push({ t: 'sfx', name: 'busted' });
    ev.push({ t: 'shake', power: 1.6 });
    ev.push({ t: 'flash', kind: 'bad' });
    ev.push({ t: 'announce', text: 'Busted. Trace reached 100 percent.' });
  }

  /** Skip the bust cutscene (any key) — the result is already settled. */
  skipCutscene(): EngineEvent[] {
    const rt = this.rt;
    if (rt?.cutscene) {
      for (const l of rt.cutscene.lines) this.outbox.push(print(l.text, l.cls ?? 'info', 'instant'));
      rt.cutscene.lines = [];
      rt.cutscene.timer = 0;
      const then = rt.cutscene.then;
      rt.cutscene.then = undefined;
      then?.();
    }
    return this.drainOutbox();
  }

  /* ------------------------------- transfers ------------------------------- */

  private transferWatched(rt: Runtime): boolean {
    return !!rt.transfer && rt.watchdogNodeId === rt.transfer.nodeId && rt.decoyTimer <= 0;
  }

  private currentRate(rt: Runtime): { rate: number; source: string } {
    if (rt.ended) return { rate: 0, source: 'offline' };
    if (rt.transfer) {
      const base = rt.transfer.op === 'upload' ? CONFIG.trace.uploadPerSecond : CONFIG.trace.downloadPerSecond;
      const watched = this.transferWatched(rt);
      const rate = base * rt.eff.transferTraceFactor * (watched ? CONFIG.trace.watchdogTransferMultiplier : 1);
      return { rate, source: `${rt.transfer.op}${watched ? ' · watchdog ×2' : ''}${rt.spec.modifier === 'noisy' ? ' · noisy link' : ''}` };
    }
    if (rt.pending) return { rate: 0, source: rt.pending.action.type === 'scan' ? 'sweeping' : 'spinning up' };
    const rate = this.idleRate(rt);
    return { rate, source: rt.phase === 'alert' ? 'idle creep ×2 (alert)' : 'idle creep' };
  }

  private idleRate(rt: Runtime): number {
    return CONFIG.trace.idlePerSecond * (rt.phase === 'alert' ? CONFIG.trace.alertCreepMultiplier : 1) * rt.eff.idleFactor;
  }

  private tickTransfer(rt: Runtime, dt: number, ev: EngineEvent[]): void {
    const tr = rt.transfer!;
    this.addTrace(rt, this.currentRate(rt).rate * dt, tr.op === 'upload' ? 'upload' : 'download', ev);
    if (!rt.transfer || rt.ended) return;
    tr.progress = Math.min(1, tr.progress + dt / tr.seconds);
    if (tr.progress >= tr.nextProgressAt) {
      tr.nextProgressAt = Math.min(1.01, tr.progress + 0.2);
      ev.push({ t: 'progress', pct: Math.floor(tr.progress * 100), label: `${tr.op === 'upload' ? '⇡' : '⇣'} ${tr.file.name}` });
    }
    if (tr.progress < 1) return;
    rt.transfer = null;
    ev.push({ t: 'progress', pct: 100, label: `${tr.op === 'upload' ? '⇡' : '⇣'} ${tr.file.name}` });
    if (tr.op === 'upload') {
      tr.dir.files.push({ ...tr.file });
      rt.payloadPlaced = true;
      rt.sessionXp += CONFIG.economy.xpPerFile;
      ev.push(print(`[+] payload planted: ${tr.path}. it's already talking home.`, 'good'));
      ev.push({ t: 'sfx', name: 'cash' });
    } else {
      const f = tr.file;
      tr.dir.files = tr.dir.files.filter((x) => x !== f);
      rt.pulled.add(`${tr.nodeId}|${tr.path}`);
      rt.downloadsCount++;
      rt.downloadedValue += f.value ?? 0;
      rt.sessionCash += f.value ?? 0;
      rt.sessionXp += CONFIG.economy.xpPerFile;
      if (f.targetId) rt.downloadedTargets.add(f.targetId);
      if (nodeById(rt.spec, tr.nodeId)?.vault) rt.vaultLooted = true;
      ev.push(print(`[+] download complete: ${f.name} (+$${f.value})${f.tag === 'target' ? ' · objective' : ''}`, 'good'));
      ev.push({ t: 'sfx', name: 'cash' });
    }
    this.checkObjective(rt, ev);
    if (tr.op === 'download') this.tutorialAdvance(rt, 'download-complete', ev);
    this.coach(rt, ev);
    ev.push({ t: 'state' });
  }

  private checkObjective(rt: Runtime, ev: EngineEvent[]): void {
    const st = { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced };
    if (rt.objectiveAnnounced || !objectiveDone(rt.spec.objective, st)) return;
    rt.objectiveAnnounced = true;
    ev.push(print(`[★] OBJECTIVE MET — ${objectiveProgressText(rt.spec, st)}.`, 'good'));
    ev.push({ t: 'announce', text: 'Objective met.' });
    ev.push({ t: 'flash', kind: 'good' });
    // The tutorial keeps its own step-by-step guidance.
    if (rt.spec.kind === 'tutorial') return;
    ev.push(
      print(
        rt.trace < CONFIG.trace.cleanExitUnder
          ? `    \`disconnect\` now for a CLEAN EXIT (under ${CONFIG.trace.cleanExitUnder}%) — or get greedy.`
          : `    over ${CONFIG.trace.cleanExitUnder}%: \`proxy\` or wipe logs for a clean exit, or just \`disconnect\`.`,
        'dim'
      )
    );
    ev.push({ t: 'handler', text: "That's the job. Bring it home — cold." });
  }

  /* ------------------------------- mission end ------------------------------ */

  /** Pure bookkeeping: score, profile, telemetry, records, daily. Runs exactly once per run. */
  private settleRun(rt: Runtime, ended: 'disconnect' | 'busted'): MissionResult {
    rt.ended = true;
    const spec = rt.spec;
    const d = spec.descriptor;
    const isTutorial = spec.kind === 'tutorial';
    const objState = { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced };
    const objectiveComplete = ended !== 'busted' && objectiveDone(spec.objective, objState);
    const score = scoreRun({
      ended,
      traceExact: rt.trace,
      objectiveComplete,
      lootCash: rt.sessionCash,
      sessionXp: rt.sessionXp,
      logsWiped: rt.logsWiped,
      descriptor: d,
      practice: rt.practice,
      modifier: spec.modifier,
    });

    const xpBefore = this.profile.xp;
    const rankBefore = CONFIG.ranks[rankIndexForXp(xpBefore)]!.name;
    this.profile.cash += score.cash;
    this.profile.xp += score.xp;
    if (objectiveComplete && isTutorial) this.profile.tutorialDone = true;
    let campaignCleared = false;
    if (objectiveComplete && d.mode === 'campaign' && !rt.practice && spec.index === this.profile.contractsDone + 1) {
      this.profile.contractsDone = spec.index;
      if (spec.index >= CONFIG.mission.count && !this.profile.campaignComplete) {
        this.profile.campaignComplete = true;
        campaignCleared = true;
      }
    }
    const rankAfterName = CONFIG.ranks[rankIndexForXp(this.profile.xp)]!.name;
    const unlocked = unlocksBetween(xpBefore, this.profile.xp).map((m) => m.id);

    const { have, need } = objectiveCount(spec.objective, objState);
    const code = encodeShareCode(d);
    const finishedAt = new Date(this.now()).toISOString();
    const result: MissionResult = {
      runId: rt.runId,
      outcome: score.outcome,
      objectiveComplete,
      exit: score.exit,
      missionName: spec.name,
      index: spec.index,
      descriptor: { ...d },
      code,
      seed: d.seed,
      isTutorial,
      practice: rt.practice,
      traceExact: rt.trace,
      trace: Math.floor(rt.trace),
      peakTrace: Math.floor(rt.peakTrace),
      cash: score.cash,
      xp: score.xp,
      activeSeconds: Math.round(rt.elapsed * 10) / 10,
      filesStolen: have,
      filesRequired: need,
      objectiveLabel: objectiveLabel(spec),
      logsWiped: rt.logsWiped,
      lootCash: score.lootCash,
      cleanBonus: score.cleanBonus,
      missionBonus: score.missionBonus,
      modifierBonus: score.modifierBonus,
      vaultLooted: rt.vaultLooted,
      loadout: { module: rt.loadout.module, upgrades: { ...rt.loadout.upgrades } },
      breakdown: [...rt.breakdown.entries()]
        .map(([label, delta]) => ({ label, delta: Math.round(delta * 10) / 10 }))
        .filter((b) => b.delta !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
      breakdownComplete: rt.breakdownComplete,
      rankBefore,
      rankAfter: rankAfterName !== rankBefore ? rankAfterName : null,
      unlocked,
      campaignCleared,
      finishedAt,
    };

    if (!isTutorial) {
      this.countEnd(rt, result);
      const entry: RecordEntry = {
        runId: rt.runId,
        key: recordKey(d, rt.loadout, rt.practice),
        code,
        label: `${spec.name} · ${describeDescriptor(d)}`,
        mode: d.mode,
        practice: rt.practice,
        outcome: result.outcome,
        objectiveComplete,
        cash: result.cash,
        activeSeconds: result.activeSeconds,
        finalTrace: result.trace,
        loadoutLabel: loadoutLabel(rt.loadout),
        date: finishedAt,
      };
      const rec = recordRun(this.records, entry);
      this.records = rec.state;
      (result as MissionResult & { newBest?: boolean; previousBest?: RecordEntry | null }).newBest = rec.newBest && !!rec.previous;
      (result as MissionResult & { previousBest?: RecordEntry | null }).previousBest = rec.previous;
      if (d.mode === 'daily' && !rt.practice) {
        const date = dailyDateOf(d)!;
        this.daily[date] = {
          date,
          runId: rt.runId,
          status: 'finished',
          outcome: result.outcome,
          cash: result.cash,
          finalTrace: result.trace,
          activeSeconds: result.activeSeconds,
        };
        this.trimDaily();
      }
    }
    this.lastResult = result;
    this.pendingSession = null;
    this.persist();
    return result;
  }

  /** The after-action screen. */
  private presentResult(rt: Runtime, result: MissionResult, ev: EngineEvent[]): void {
    const isTutorial = result.isTutorial;
    const tone: Cls = result.outcome === 'busted' ? 'bad' : result.outcome === 'clean' ? 'good' : 'warn';
    ev.push(print('', 'dim'));
    ev.push(print('─────────────────────── AFTER-ACTION ────────────────────', tone, 'instant'));
    const label = OUTCOME_LABEL[result.outcome];
    if (result.outcome === 'busted') {
      ev.push(print(`outcome   BUSTED at ${result.trace}% trace (peak ${result.peakTrace}%)`, 'bad'));
      ev.push(print('cash      $0 (the grid keeps it)', 'bad'));
      ev.push(print(`xp        +${result.xp} (halved)`, 'warn'));
    } else if (result.outcome === 'early') {
      ev.push(print(`outcome   ${label} at ${result.trace}% trace — ${result.objectiveLabel}: ${result.filesStolen}/${result.filesRequired} · contract UNPAID`, 'warn'));
      ev.push(print(`cash      $${result.cash}${result.cash ? ' (loot you actually carried out — no bonuses)' : ''}`, 'warn'));
      ev.push(print(`xp        +${result.xp}${result.xp ? " (the work counted, the job didn't)" : ' (nothing done, nothing earned)'}`, 'warn'));
    } else {
      ev.push(print(`outcome   ${label} at ${result.trace}% trace (peak ${result.peakTrace}%)`, tone));
      ev.push(print(`objective ${result.objectiveLabel} ✓`, 'info'));
      const parts = [`loot $${result.lootCash}`];
      if (result.cleanBonus) parts.push(`clean ×${CONFIG.economy.cleanMultiplier} +$${result.cleanBonus}`);
      if (result.logsWiped) parts.push(`logs +$${result.logsWiped * CONFIG.economy.cashPerLog}`);
      if (result.missionBonus) parts.push(`contract +$${result.missionBonus}`);
      if (result.modifierBonus) parts.push(`hazard +$${result.modifierBonus}`);
      ev.push(print(`cash      ${parts.join(' · ')}`, 'good'));
      ev.push(print(`payout    $${result.cash} · xp +${result.xp}${result.vaultLooted ? ' · VAULT CRACKED' : ''}`, 'good'));
    }
    ev.push(print(`time      ${fmtSeconds(result.activeSeconds)} active · rig: ${loadoutLabel(result.loadout)}`, 'dim'));
    ev.push(print(`trace breakdown${result.breakdownComplete ? '' : ' (part of this run predates detailed logging)'}:`, 'dim'));
    for (const b of result.breakdown) {
      const name = b.label === 'unrecorded' ? 'earlier (unrecorded)' : b.label;
      ev.push(print(`  ${pad(name, 20)} ${b.delta > 0 ? '+' : ''}${b.delta}`, b.delta > 0 ? 'warn' : 'good'));
    }
    const r = result as MissionResult & { newBest?: boolean; previousBest?: RecordEntry | null };
    if (!isTutorial && r.newBest) ev.push(print('[★] NEW PERSONAL BEST for this job and rig.', 'accent'));
    if (result.rankAfter) {
      ev.push(print(`[★] RANK UP — the wire now calls you ${result.rankAfter}.`, 'accent'));
      for (const id of result.unlocked) {
        const m = moduleDef(id);
        if (m) ev.push(print(`[★] UNLOCKED: ${m.name} — ${m.blurb}. \`equip ${m.id}\` at home.`, 'accent'));
      }
    }
    if (!isTutorial && result.descriptor.mode === 'daily') {
      ev.push(print(result.practice ? 'daily practice — your recorded attempt stands.' : 'daily attempt recorded. later runs today are practice.', 'dim'));
    }
    if (result.code) ev.push(print(`share     ${result.code}`, 'dim'));
    ev.push(print('─────────────────────────────────────────────────────────', 'dim', 'instant'));

    if (isTutorial) {
      ev.push(print('tutorial complete. the glow fades now — but TAB still fills suggestions, and `help` never leaves.', 'accent'));
      ev.push(print('contracts are open: `run 1`. same verbs, real teeth.', 'info'));
      ev.push({ t: 'handler', text: "That's the whole trade. The board's open — `run 1` when you're ready. I won't hold your hand this time." });
      this.setSuggest(ev, 'run 1');
      ev.push({ t: 'sfx', name: 'clean' });
    } else if (result.outcome === 'busted') {
      ev.push(print(`[ENTER] retry the same job · \`contracts\` for the board`, 'dim'));
      ev.push({ t: 'sfx', name: 'busted' });
      this.setSuggest(ev, 'retry');
    } else if (result.outcome === 'early') {
      ev.push(print('the Broker, dryly: "short delivery. no sticker." [ENTER] to retry.', 'handler'));
      this.setSuggest(ev, 'retry');
      ev.push({ t: 'sfx', name: 'ok' });
    } else {
      ev.push(print(`the Broker: "${rt.spec.debrief}"`, 'handler'));
      if (result.outcome === 'clean') {
        ev.push({ t: 'sfx', name: 'clean' });
        ev.push({ t: 'flash', kind: 'good' });
      } else {
        ev.push({ t: 'sfx', name: 'ok' });
      }
      ev.push(print('[ENTER] replays this job · `contracts` for the board', 'dim'));
      this.setSuggest(ev, this.nextSuggestion());
    }
    if (result.campaignCleared) {
      for (const line of EPILOGUE) ev.push(print(line.text, line.cls, 'instant'));
      this.profile.endingSeen = true;
      this.setSuggest(ev, 'daily');
      this.persist();
    }

    // The tutorial lands on the home terminal so ENTER can't silently re-run
    // it; real jobs use the results screen where empty ENTER = instant retry.
    this.mode = isTutorial ? 'home' : 'post';
    this.rt = null;
    ev.push({ t: 'missionEnd', result });
    ev.push({ t: 'announce', text: `${OUTCOME_LABEL[result.outcome]}. Payout ${result.cash} dollars.` });
    ev.push({ t: 'state' });
  }

  private nextSuggestion(): string {
    if (this.profile.campaignComplete) return this.profile.endingSeen ? 'daily' : 'epilogue';
    if (!this.profile.tutorialDone) return 'tutorial';
    return `run ${Math.min(CONFIG.mission.count, this.profile.contractsDone + 1)}`;
  }

  /* -------------------------------- telemetry ------------------------------- */

  private bucket(map: Record<string, OutcomeCounts>, key: string): OutcomeCounts {
    if (!map[key]) map[key] = { started: 0, completed: 0, early: 0, busted: 0 };
    return map[key]!;
  }

  private contractBucketKey(d: MissionDescriptor): string {
    return d.mode === 'campaign' ? `c${d.tier}` : d.mode;
  }

  private countStart(rt: Runtime): void {
    if (rt.spec.kind !== 'contract') return;
    const t = this.profile.telemetry;
    t.runsStarted++;
    this.bucket(t.byContract, this.contractBucketKey(rt.spec.descriptor)).started++;
    this.bucket(t.byObjective, rt.spec.objective.type).started++;
  }

  private countEnd(rt: Runtime, result: MissionResult): void {
    const t = this.profile.telemetry;
    t.runsEnded++;
    const c = this.bucket(t.byContract, this.contractBucketKey(rt.spec.descriptor));
    const o = this.bucket(t.byObjective, rt.spec.objective.type);
    if (result.outcome === 'busted') {
      t.runsBusted++;
      c.busted++;
      o.busted++;
    } else if (result.objectiveComplete) {
      t.runsCompleted++;
      c.completed++;
      o.completed++;
    } else {
      t.runsShort++;
      c.early++;
      o.early++;
    }
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

  /* -------------------------------- tutorial ------------------------------- */

  private tutorialAdvance(rt: Runtime, marker: string, ev: EngineEvent[]): void {
    if (rt.spec.kind !== 'tutorial' || rt.ended) return;
    const step = TUTORIAL_STEPS[rt.tutorialStep];
    if (!step || step.advanceOn !== marker) return;
    rt.tutorialStep++;
    this.tutorialGuide(rt, ev);
  }

  private tutorialGuide(rt: Runtime, ev: EngineEvent[], lead = 'Next'): void {
    const next = TUTORIAL_STEPS[rt.tutorialStep];
    if (!next) return;
    this.setSuggest(ev, next.cmd.join(' '));
    if (next.note) ev.push({ t: 'handler', text: `${lead}: \`${next.cmd.join(' ')}\` — ${next.note}. TAB fills it.` });
  }

  private tutorialRewind(rt: Runtime, marker: string, ev: EngineEvent[]): void {
    if (rt.spec.kind !== 'tutorial' || rt.ended) return;
    const idx = TUTORIAL_STEPS.findIndex((s) => s.advanceOn === marker);
    if (idx < 0 || idx > rt.tutorialStep) return;
    rt.tutorialStep = idx;
    const step = TUTORIAL_STEPS[idx]!;
    this.setSuggest(ev, step.cmd.join(' '));
    ev.push({ t: 'handler', text: `Lock re-armed — the glow rewound with it. Next: \`${step.cmd.join(' ')}\`. TAB fills it.` });
  }

  private tutorialGate(rt: Runtime, verb: string, args: string[], ev: EngineEvent[]): boolean {
    if (rt.spec.kind !== 'tutorial') return true;
    const exempt = ['help', '?', 'man', 'clear', 'cls', 'skipintro', 'profile', 'settings', 'verbs', 'share'];
    if (exempt.includes(verb)) return true;
    const step = TUTORIAL_STEPS[rt.tutorialStep];
    if (!step) return true;
    const canonical = lookupCommand(verb)?.name ?? verb;
    const argMatch =
      step.cmd.length === 1 ||
      (() => {
        const given = (args[0] ?? '').toLowerCase();
        const want = step.cmd[1]!.toLowerCase();
        if (given === want) return true;
        if (given.split('/').filter(Boolean).pop() === want.split('/').pop()) return true;
        const wanted = this.resolveNode(rt, want);
        const givenNode = this.resolveNode(rt, given);
        return !!wanted && !!givenNode && wanted.id === givenNode.id;
      })();
    if (step.cmd[0] === canonical && argMatch) return true;
    if (step.cmd[0] === 'input' && (verb === 'input' || /^\d+$/.test(verb))) return true;
    ev.push({ t: 'handler', text: `Focus. Next move: \`${step.cmd.join(' ')}\` — ${step.note}.` });
    ev.push(print(`[handler] the glow knows best: \`${step.cmd.join(' ')}\``, 'warn'));
    this.setSuggest(ev, step.cmd.join(' '));
    return false;
  }

  /* --------------------------------- coach ---------------------------------- */

  /** Next-move suggestion (TAB fills it). Never picks a route at a fork. */
  private coach(rt: Runtime, ev: EngineEvent[]): void {
    if (rt.spec.kind === 'tutorial' || rt.ended || !this.settings.assist) return;
    this.setSuggest(ev, this.coachSuggestion(rt));
  }

  private coachSuggestion(rt: Runtime): string {
    const spec = rt.spec;
    const st = { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced };
    if (rt.puzzle || rt.transfer || rt.pending) return '';
    if (objectiveDone(spec.objective, st)) return 'disconnect';
    if (!rt.scanned) return 'scan';
    const here = objectiveRoleOf(spec, rt.currentId, st);
    if (here === 'target' || here === 'dossier') {
      const p = this.targetPathsOn(rt, rt.currentId)[0];
      if (p) return `download ${p}`;
    }
    if (here === 'drop' && spec.objective.type === 'payload') return `upload ${spec.objective.payloadName} ${spec.objective.dir}`;
    // Head for the nearest node that still matters to the objective.
    const goals = spec.nodes.filter((n) => objectiveRoleOf(spec, n.id, st));
    let best: string[] | null = null;
    for (const g of goals) {
      const path = shortestPath(spec, rt.currentId, g.id, (id) => !nodeById(spec, id)?.vault);
      if (path && (!best || path.length < best.length)) best = path;
    }
    if (!best || best.length < 2) return '';
    // At a fork the route is the player's call. A neighbor only counts as a road
    // if it reaches a goal without coming back through here — past the junction
    // the road not taken is a dead end, not a choice.
    const roads = neighbors(spec, rt.currentId).filter(
      (id) =>
        !rt.breached.has(id) &&
        !nodeById(spec, id)?.vault &&
        goals.some((g) => g.id !== rt.currentId && shortestPath(spec, id, g.id, (x) => x !== rt.currentId && !nodeById(spec, x)?.vault))
    );
    if (roads.length > 1) return '';
    const firstLocked = best.findIndex((id) => !rt.breached.has(id));
    if (firstLocked < 0) return `connect ${nodeById(spec, best[best.length - 1]!)!.ip}`;
    const step = nodeById(spec, best[firstLocked]!)!;
    if (firstLocked === 1) return `breach ${step.ip}`;
    const via = nodeById(spec, best[firstLocked - 1]!)!;
    return `connect ${via.ip}`;
  }

  /* -------------------------------- helpers -------------------------------- */

  private later(rt: Runtime, seconds: number, action: PendingAction): void {
    rt.pending = { remaining: seconds, action };
  }

  private currentVfs(rt: Runtime): Vfs {
    return rt.vfs.get(rt.currentId)!;
  }

  private liveFiles(rt: Runtime, nodeId: string): FileSpec[] {
    const v = rt.vfs.get(nodeId);
    return v ? walkFiles(v.rootDir) : [];
  }

  private pathOf(rt: Runtime, nodeId: string, file: FileSpec): string {
    const v = rt.vfs.get(nodeId);
    return v ? (findPath(v.rootDir, file) ?? file.name) : file.name;
  }

  private targetPathsOn(rt: Runtime, nodeId: string): string[] {
    const obj = rt.spec.objective;
    return this.liveFiles(rt, nodeId)
      .filter((f) => f.tag === 'target' && f.targetId && !rt.downloadedTargets.has(f.targetId) && (obj.type === 'flagged' ? obj.targetIds.includes(f.targetId) : obj.type === 'dossier' && f.targetId === obj.targetId))
      .map((f) => this.pathOf(rt, nodeId, f));
  }

  /** Where this node's cipher wheel tag lives (owned approach nodes first). */
  private clueHint(rt: Runtime, lockNodeId: string): string | null {
    const spots: string[] = [];
    for (const n of rt.spec.nodes) {
      const f = this.liveFiles(rt, n.id).find((x) => x.clueFor === lockNodeId);
      if (!f) continue;
      const where = n.id === rt.currentId ? 'this node' : n.hostname;
      spots.push(`${this.pathOf(rt, n.id, f)} on ${where}`);
    }
    if (!spots.length) return null;
    spots.sort((a, b) => (a.endsWith('this node') ? -1 : b.endsWith('this node') ? 1 : 0));
    return spots.slice(0, 2).join(' or ');
  }

  private breachCost(rt: Runtime, nodeId: string): number {
    const node = nodeById(rt.spec, nodeId);
    if (!node) return 0;
    const base = CONFIG.trace.breachBySecurity[node.security]!;
    return rt.watchdogNodeId === nodeId && rt.decoyTimer <= 0 ? base * CONFIG.trace.watchdogBreachMultiplier : base;
  }

  private ownedNeighborOf(rt: Runtime, nodeId: string): MissionSpec['nodes'][number] | null {
    const id = neighbors(rt.spec, nodeId).find((nb) => rt.breached.has(nb));
    return id ? nodeById(rt.spec, id)! : null;
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
    for (const d of dir.dirs ?? []) if (d.name.toLowerCase().startsWith(prefix.toLowerCase())) items.push(dirPart + d.name + '/');
    for (const f of dir.files) if (f.name.toLowerCase().startsWith(prefix.toLowerCase())) items.push(dirPart + f.name);
    return { items, from: input.length - prefix.length };
  }

  private spawnPatrol(rt: Runtime, ev: EngineEvent[]): void {
    const dist = distances(rt.spec, 'n0');
    const start = rt.spec.nodes
      .filter((n) => n.id !== 'n0' && !n.vault)
      .sort((a, b) => (dist.get(b.id) ?? 0) - (dist.get(a.id) ?? 0) || a.id.localeCompare(b.id))[0];
    if (!start) return;
    rt.watchdogNodeId = start.id;
    rt.watchdogTimer = rt.eff.watchdogMoveSeconds;
    ev.push(print(`[!] ACTIVE PATROL — a watchdog already walks this network (now at ${start.hostname}).`, 'warn'));
    ev.push(print('    breaching or transferring where it sits costs double. `decoy` diverts it.', 'dim'));
  }

  private moveWatchdog(rt: Runtime, ev: EngineEvent[]): void {
    if (!rt.watchdogNodeId) return;
    const options = neighbors(rt.spec, rt.watchdogNodeId).filter((id) => id !== 'n0');
    if (!options.length) return;
    rt.watchdogNodeId = rt.rng.pick(options);
    if (rt.watchdogNodeId === rt.currentId || (rt.transfer && rt.transfer.nodeId === rt.watchdogNodeId)) {
      ev.push(print(`[!] the watchdog just walked onto ${nodeById(rt.spec, rt.watchdogNodeId)!.hostname} — your node.`, 'warn'));
    }
    ev.push({ t: 'state' });
  }

  private nodeView(rt: Runtime, n: MissionSpec['nodes'][number], pos: { depth: number; lane: number }): NodeView {
    const owned = rt.breached.has(n.id);
    const st = { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced };
    const files = this.liveFiles(rt, n.id);
    const clues = rt.spec.nodes
      .filter((m) => this.liveFiles(rt, m.id).some((f) => f.clueFor === n.id))
      .map((m) => m.hostname);
    return {
      id: n.id,
      ip: n.ip,
      hostname: n.hostname,
      security: n.security,
      status: n.id === 'n0' ? 'entry' : owned ? 'breached' : 'locked',
      isCurrent: n.id === rt.currentId,
      reachable: !owned && linked(rt.spec, rt.currentId, n.id),
      frontier: !owned && neighbors(rt.spec, n.id).some((id) => rt.breached.has(id)),
      hasTarget: !!objectiveRoleOf(rt.spec, n.id, st),
      objectiveRole: objectiveRoleOf(rt.spec, n.id, st),
      lootValue: files.filter((f) => f.tag === 'loot' || f.tag === 'target').reduce((a, f) => a + (f.value ?? 0), 0),
      logsLeft: files.filter((f) => f.tag === 'log').length,
      scanned: rt.scanned,
      vault: !!n.vault,
      route: n.route ?? null,
      breachCost: this.breachCost(rt, n.id),
      lockFamily: n.security === 0 ? null : n.puzzleFamily,
      clueAt: clues,
      neighbors: neighbors(rt.spec, n.id),
      depth: pos.depth,
      lane: pos.lane,
    };
  }

  private prompt(): string {
    if (this.mode === 'mission' && this.rt) {
      const host = nodeById(this.rt.spec, this.rt.currentId)!.hostname.toLowerCase();
      return `operator@${host}:/${this.rt.cwd.join('/')}$`;
    }
    return 'operator@homegrid:~$';
  }

  private setSuggest(ev: EngineEvent[], cmd: string): void {
    this.suggest = cmd;
    ev.push({ t: 'suggest', cmd });
  }

  private printHelp(ev: EngineEvent[], mode: GameMode): void {
    const m = mode === 'post' ? 'post' : mode;
    ev.push(print('GRID TRUST FIELD CARD 07 — verbs you get paid for:', 'accent'));
    for (const c of commandsForMode(m)) ev.push(print(`  ${pad(c.usage, 30)} ${c.summary}`, 'info'));
    ev.push(print('  `man <verb>` for the long version · TAB completes · ↑↓ history', 'dim'));
    if (m === 'post') ev.push(print('  empty ENTER on the results screen retries the same job.', 'dim'));
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
    for (const line of manPage(meta).split('\n')) ev.push(print(line, 'accent', 'instant'));
  }

  private printContracts(ev: EngineEvent[]): void {
    ev.push(print('───[ THE BOARD ]──────────────────────────────────────────', 'accent', 'instant'));
    if (this.profile.campaignComplete) ev.push(print('  ★ CAMPAIGN COMPLETE — every contract replayable.', 'accent'));
    for (let i = 1; i <= CONFIG.mission.count; i++) {
      const d = campaignDescriptor(i);
      const done = i <= this.profile.contractsDone;
      const open = i === this.profile.contractsDone + 1;
      const mark = done ? '[✓]' : open ? '[»]' : '[·]';
      const plan = [
        d.topology === 'fork' ? 'fork' : 'chain',
        d.objective === 'flagged' ? 'files' : d.objective === 'dossier' ? 'dossier' : 'payload',
        d.modifier ? CONFIG.modifiers[d.modifier].name.toLowerCase() : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const best = this.bestFor(d);
      const bestTxt = best ? ` · best ${OUTCOME_LABEL[best.outcome].toLowerCase()} $${best.cash}` : '';
      const status = done ? `cleared${bestTxt}` : open ? 'READY — `run ' + i + '`' : 'locked';
      ev.push(
        print(
          `  ${mark} #${String(i).padStart(2, '0')}  ${pad(CAMPAIGN_CODENAMES[i]!, 15)} ${pad(open || done ? plan : '???', 26)} ${status}`,
          done ? 'dim' : open ? 'good' : 'dim'
        )
      );
    }
    ev.push(print(`  rig: ${loadoutLabel(profileLoadout(this.profile))} · \`loadout\` to change`, 'dim'));
    ev.push(print('  also: `daily` challenge · `run seed <SEED>` custom job · `run <CODE>` shared job · `records`', 'dim'));
    if (this.pendingSession) {
      ev.push(print('  [!] a run is parked — `resume` or `abandon` it before starting another.', 'warn'));
      this.setSuggest(ev, 'resume');
      return;
    }
    this.setSuggest(ev, this.nextSuggestion());
  }

  private bestFor(d: MissionDescriptor): RecordEntry | null {
    const prefix = `r${CONFIG.rulesVersion}|${descriptorKey(d)}|`;
    let best: RecordEntry | null = null;
    for (const [k, e] of Object.entries(this.records.best)) {
      if (!k.startsWith(prefix)) continue;
      if (!best || compareRecords(e, best) < 0) best = e;
    }
    return best;
  }

  private cmdRun(args: string[], ev: EngineEvent[]): void {
    const first = args[0] ?? '';
    if (first.toLowerCase() === 'seed') {
      let rest = args.slice(1);
      let tier: number = CONFIG.modes.customDefaultTier;
      const flag = rest.findIndex((a) => a.toLowerCase() === '--tier');
      if (flag >= 0) {
        const n = parseInt(rest[flag + 1] ?? '', 10);
        if (!Number.isFinite(n) || n < 1 || n > CONFIG.mission.count) {
          ev.push(print(`[-] --tier takes 1–${CONFIG.mission.count}.`, 'bad'));
          return;
        }
        tier = n;
        rest = [...rest.slice(0, flag), ...rest.slice(flag + 2)];
      }
      const seed = rest.join(' ').trim();
      if (!seed) {
        ev.push(print('[-] run seed what? any text works: `run seed neon harbor` (add `--tier 1-10`).', 'bad'));
        return;
      }
      if ([...seed].length > MAX_SEED_LENGTH) {
        ev.push(print(`[-] seeds max out at ${MAX_SEED_LENGTH} characters.`, 'bad'));
        return;
      }
      const desc = customDescriptor(seed, tier);
      this.beginRun(ev, () => {
        const spec = this.specFor(desc);
        ev.push(print(`[+] custom job from seed "${seed}" — ${describeDescriptor(desc)}.`, 'good'));
        this.startMission(spec, ev);
      });
      return;
    }
    if (first.toLowerCase() === 'code' || /^CG\d+-/i.test(first)) {
      const code = first.toLowerCase() === 'code' ? args.slice(1).join('') : args.join('');
      this.runCode(code, ev);
      return;
    }
    if (first.toLowerCase() === 'daily') {
      this.cmdDaily(['start'], ev);
      return;
    }
    const n = parseInt(first, 10);
    if (!Number.isFinite(n) || n < 1 || n > CONFIG.mission.count) {
      ev.push(print(`[-] run what? \`run 1\`–\`run ${CONFIG.mission.count}\`, \`run seed <SEED>\`, or \`run <CODE>\`.`, 'bad'));
      return;
    }
    if (n > this.profile.contractsDone + 1) {
      ev.push(print(`[-] contract #${n} is locked. the Broker unlocks in order — clear #${this.profile.contractsDone + 1} first.`, 'warn'));
      return;
    }
    this.beginRun(ev, () => this.startMission(this.specFor(campaignDescriptor(n)), ev));
  }

  private runCode(code: string, ev: EngineEvent[]): void {
    const res = decodeShareCode(code);
    if (!res.ok) {
      ev.push(print(`[-] can't use that code: ${res.message}`, 'bad'));
      ev.push({ t: 'sfx', name: 'err' });
      return;
    }
    const d = res.descriptor;
    let practice = false;
    if (d.mode === 'campaign') {
      // Only the canonical contract (or its legacy gen-1 twin) can move the board.
      const canonical =
        descriptorKey(d) === descriptorKey(campaignDescriptor(d.tier)) || (d.gen === 1 && d.seed === contractSeedOf(d.tier));
      if (!canonical || d.tier > this.profile.contractsDone + 1) practice = true;
    }
    if (d.mode === 'daily') {
      const date = dailyDateOf(d);
      practice = !date || !!this.daily[date] || date !== utcDate(this.now());
    }
    this.beginRun(ev, () => {
      const spec = this.specFor(d);
      ev.push(print(`[+] shared job decoded — ${describeDescriptor(d)}.`, 'good'));
      this.startMission(spec, ev, { practice });
    });
  }

  private cmdRetry(ev: EngineEvent[]): void {
    const last = this.lastResult ? { descriptor: this.lastResult.descriptor, practice: this.lastResult.practice } : this.lastStarted;
    if (!last) {
      ev.push(print('[-] nothing to retry yet.', 'bad'));
      return;
    }
    const d = last.descriptor;
    if (d.mode === 'tutorial') {
      this.beginRun(ev, () => this.startMission(tutorialMission(), ev));
      return;
    }
    let practice = last.practice;
    if (d.mode === 'daily') {
      // The recorded attempt is spent; replays of a daily are practice.
      const date = dailyDateOf(d);
      practice = !date || !!this.daily[date];
    }
    if (d.mode === 'campaign') practice = practice || d.tier > this.profile.contractsDone + 1;
    this.beginRun(ev, () => this.startMission(this.specFor(d), ev, { practice }));
  }

  private cmdShare(ev: EngineEvent[]): void {
    const d = this.rt?.spec.descriptor ?? this.lastResult?.descriptor ?? this.lastStarted?.descriptor ?? null;
    if (!d) {
      ev.push(print('[-] nothing to share yet — run a job first.', 'dim'));
      return;
    }
    if (d.mode === 'tutorial') {
      ev.push(print('[-] the warm-up is the same for everyone — nothing to share.', 'dim'));
      return;
    }
    const code = encodeShareCode(d);
    ev.push(print(`share code: ${code}`, 'accent', 'instant'));
    ev.push(print(`  ${describeDescriptor(d)}`, 'dim'));
    ev.push(print('  `run <code>` rebuilds this exact network on any terminal, any rank.', 'dim'));
  }

  private cmdResume(ev: EngineEvent[]): void {
    if (!this.pendingSession) {
      if (this.brokenSession) {
        ev.push(print(`[-] the parked run can't be rebuilt (${this.brokenSession.reason}). \`abandon\` clears it.`, 'warn'));
      } else {
        ev.push(print('nothing to resume.', 'dim'));
      }
      return;
    }
    const s = this.pendingSession;
    const problem = sessionProblem(s);
    if (problem) {
      this.brokenSession = { reason: problem, label: describeDescriptor(s.descriptor), raw: s };
      this.pendingSession = null;
      this.persist();
      ev.push(print(`[-] the parked run can't be rebuilt (${problem}). \`abandon\` clears it.`, 'bad'));
      this.setSuggest(ev, 'abandon');
      return;
    }
    // Rebuild exactly the draw that was played — no re-validation, no redraw.
    const spec = s.descriptor.mode === 'tutorial' ? tutorialMission() : generateFor(s.descriptor, s.draw.seed, s.draw.relax);
    this.pendingSession = null;
    this.startMission(spec, ev, { resume: s });
    if (spec.kind === 'contract') this.profile.telemetry.resumes++;
    ev.push(print('[+] session restored — the clock was paused while you were away.', 'good'));
    this.persist();
  }

  private cmdAbandon(ev: EngineEvent[]): void {
    if (this.pendingSession) {
      const s = this.pendingSession;
      if (s.descriptor.mode === 'daily' && !s.practice) {
        const date = dailyDateOf(s.descriptor);
        if (date) {
          this.daily[date] = { date, runId: s.runId, status: 'abandoned' };
          ev.push(print(`[-] daily ${date} attempt abandoned — it stays on record as not finished.`, 'warn'));
        }
      }
      this.pendingSession = null;
      this.persist();
      ev.push(print('[-] parked run dropped. nothing scored.', 'warn'));
      this.setSuggest(ev, this.nextSuggestion());
      return;
    }
    if (this.brokenSession) {
      this.brokenSession = null;
      this.persist();
      ev.push(print('[-] broken session cleared. your profile is untouched.', 'warn'));
      this.setSuggest(ev, this.nextSuggestion());
      return;
    }
    ev.push(print('nothing to abandon.', 'dim'));
  }

  private cmdEpilogue(ev: EngineEvent[]): void {
    if (!this.profile.campaignComplete) {
      ev.push(print('[-] the Broker has nothing to tell you yet. finish the board.', 'dim'));
      return;
    }
    for (const line of EPILOGUE) ev.push(print(line.text, line.cls, 'instant'));
    if (!this.profile.endingSeen) {
      this.profile.endingSeen = true;
      this.persist();
    }
    this.setSuggest(ev, 'daily');
  }

  /* --------------------------------- daily --------------------------------- */

  private cmdDaily(args: string[], ev: EngineEvent[]): void {
    const date = utcDate(this.now());
    const d = dailyDescriptor(date);
    const attempt = this.daily[date];
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'start' || sub === 'go' || sub === 'play') {
      if (this.pendingSession && attempt?.status === 'live' && this.pendingSession.runId === attempt.runId) {
        ev.push(print('[i] your recorded attempt is parked — resuming it.', 'sys'));
        this.cmdResume(ev);
        return;
      }
      const practice = !!attempt;
      this.beginRun(ev, () => this.startMission(this.specFor(d), ev, { practice }));
      return;
    }
    ev.push(print(`───[ DAILY · ${date} UTC ]─────────────────────────────`, 'accent', 'instant'));
    ev.push(print(`  ${describeDescriptor(d)}`, 'info'));
    ev.push(print('  same job for every operator today · fixed stock rig (no upgrades, no module)', 'dim'));
    const best = this.bestFor(d);
    if (!attempt) {
      ev.push(print('  your FIRST run today is the recorded attempt. reloads and resumes keep it alive.', 'warn'));
      ev.push(print('  `daily start` when ready.', 'good'));
    } else if (attempt.status === 'live') {
      ev.push(print('  recorded attempt in progress — `resume` to continue it.', 'warn'));
    } else if (attempt.status === 'abandoned') {
      ev.push(print('  recorded attempt: ABANDONED. `daily start` runs practice.', 'dim'));
    } else {
      ev.push(
        print(
          `  recorded attempt: ${OUTCOME_LABEL[attempt.outcome!]} · $${attempt.cash} · ${attempt.finalTrace}% trace · ${fmtSeconds(attempt.activeSeconds ?? 0)}`,
          'good'
        )
      );
      ev.push(print('  `daily start` runs practice (won\'t overwrite it).', 'dim'));
    }
    if (best) ev.push(print(`  best today (any slot): ${OUTCOME_LABEL[best.outcome]} · $${best.cash}`, 'dim'));
    ev.push(print(`  code: ${encodeShareCode(d)}`, 'dim'));
    const past = Object.values(this.daily)
      .filter((a) => a.date !== date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
    for (const a of past) {
      ev.push(print(`  ${a.date}: ${a.status === 'finished' ? `${OUTCOME_LABEL[a.outcome!]} $${a.cash}` : a.status}`, 'dim'));
    }
    this.setSuggest(ev, attempt?.status === 'live' ? 'resume' : 'daily start');
  }

  private trimDaily(): void {
    const dates = Object.keys(this.daily).sort();
    for (const old of dates.slice(0, Math.max(0, dates.length - CONFIG.daily.keepDays))) delete this.daily[old];
  }

  /* ------------------------------ loadout/equip ----------------------------- */

  private printLoadout(ev: EngineEvent[]): void {
    const lo = profileLoadout(this.profile);
    const eff = effectiveFor(lo, null);
    ev.push(print('───[ RIG LOADOUT ]────────────────────────────────', 'accent', 'instant'));
    ev.push(print(`  slot       ${lo.module ? moduleDef(lo.module)!.name : '(empty)'}${lo.module ? ' · `equip none` to clear' : ''}`, 'accent'));
    for (const m of CONFIG.modules) {
      const unlocked = moduleUnlocked(m.id, this.profile.xp);
      const need = CONFIG.ranks[rankIndex(m.unlockRank)]!.xp - this.profile.xp;
      ev.push(
        print(
          `  ${pad(m.id, 7)}    ${pad(m.name, 13)} ${unlocked ? '[ready]' : `[locked — ${m.unlockRank}, ${Math.max(0, Math.ceil(need))} xp to go]`}`,
          unlocked ? 'info' : 'dim'
        )
      );
      ev.push(print(`             transfer time ×${m.transferDuration.toFixed(2)} · trace rate ×${m.transferTraceRate.toFixed(2)} — ${m.blurb}`, 'dim'));
    }
    const per = CONFIG.trace.downloadPerSecond * eff.transferTraceFactor;
    ev.push(
      print(
        `  effective  download ${eff.downloadSeconds.toFixed(2)}s @ +${per.toFixed(1)}/s ≈ ${(per * eff.downloadSeconds).toFixed(1)} trace/file · fuse +${eff.fuseBonus}s · proxy ×${eff.proxy} · decoy ×${eff.decoy}`,
        'good'
      )
    );
    ev.push(print(`  permanent  ${loadoutLabel({ module: null, upgrades: lo.upgrades }).replace('no module · ', '')}`, 'dim'));
    ev.push(print('  `equip <burst|quiet|none>` — modules are free once unlocked. daily runs use a fixed stock rig.', 'dim'));
  }

  private cmdEquip(args: string[], ev: EngineEvent[]): void {
    const id = (args[0] ?? '').toLowerCase();
    if (!id) {
      this.printLoadout(ev);
      return;
    }
    if (id === 'none' || id === 'off' || id === 'empty') {
      this.profile.equipped = null;
      this.persist();
      ev.push(print('[+] module slot cleared. stock transfers.', 'good'));
      ev.push({ t: 'state' });
      return;
    }
    const m = moduleDef(id);
    if (!m) {
      ev.push(print(`[-] no module '${id}'. try \`burst\`, \`quiet\`, or \`none\`.`, 'bad'));
      return;
    }
    if (!moduleUnlocked(m.id, this.profile.xp)) {
      ev.push(print(`[-] ${m.name} unlocks at ${m.unlockRank}. keep working.`, 'warn'));
      return;
    }
    this.profile.equipped = m.id;
    this.persist();
    const eff = effectiveFor(profileLoadout(this.profile), null);
    const per = CONFIG.trace.downloadPerSecond * eff.transferTraceFactor;
    ev.push(print(`[+] ${m.name} slotted — downloads ${eff.downloadSeconds.toFixed(2)}s @ +${per.toFixed(1)}/s (≈${(per * eff.downloadSeconds).toFixed(1)} trace per file).`, 'good'));
    ev.push({ t: 'sfx', name: 'ok' });
    ev.push({ t: 'state' });
  }

  private cmdSettings(args: string[], ev: EngineEvent[]): void {
    const [key, ...rest] = args;
    const val = rest.join(' ').toLowerCase();
    const s = this.settings;
    if (!key) {
      ev.push(
        print(
          `volume ${s.volume} · mute ${s.muted ? 'on' : 'off'} · crt ${s.crt ? 'on' : 'off'} · motion ${s.motion ? 'on' : 'off'} · typing ${s.typing ? 'on' : 'off'} · assist ${s.assist ? 'on' : 'off'}`,
          'info'
        )
      );
      ev.push(print('`settings volume 0.5` · `settings <mute|crt|motion|typing|assist> on|off`', 'dim'));
      return;
    }
    const k = key.toLowerCase();
    if (k === 'volume') {
      const v = parseFloat(val);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        ev.push(print('[-] volume is 0.0 – 1.0.', 'bad'));
        return;
      }
      s.volume = v;
      s.muted = v === 0;
    } else if (['mute', 'crt', 'motion', 'typing', 'assist'].includes(k)) {
      if (val !== 'on' && val !== 'off') {
        ev.push(print(`[-] ${k} on|off.`, 'bad'));
        return;
      }
      const on = val === 'on';
      if (k === 'mute') s.muted = on;
      if (k === 'crt') s.crt = on;
      if (k === 'motion') s.motion = on;
      if (k === 'typing') s.typing = on;
      if (k === 'assist') {
        s.assist = on;
        if (!on && this.rt && this.rt.spec.kind !== 'tutorial') this.setSuggest(ev, '');
      }
    } else {
      ev.push(print(`[-] unknown setting '${key}'. volume · mute · crt · motion · typing · assist`, 'bad'));
      return;
    }
    this.persist();
    ev.push(print(`[+] saved: ${k} ${val}.`, 'good'));
    ev.push({ t: 'state' });
  }

  private printProfile(ev: EngineEvent[]): void {
    const idx = rankIndexForXp(this.profile.xp);
    const next = CONFIG.ranks[idx + 1] ?? null;
    ev.push(print('───[ OPERATOR FILE ]───────────────', 'accent', 'instant'));
    ev.push(print(`  rank     ${CONFIG.ranks[idx]!.name}`, 'accent'));
    ev.push(print(`  xp       ${Math.round(this.profile.xp)}${next ? ` / ${next.xp} (next: ${next.name})` : ' — maxed'}`, 'info'));
    ev.push(print(`  cash     $${Math.round(this.profile.cash)}`, 'good'));
    ev.push(
      print(
        `  cleared  ${this.profile.contractsDone}/${CONFIG.mission.count} contracts${this.profile.campaignComplete ? ' · CAMPAIGN COMPLETE' : ''}${this.profile.tutorialDone ? '' : ' · tutorial pending'}`,
        'dim'
      )
    );
    ev.push(print(`  rig      ${loadoutLabel(profileLoadout(this.profile))}`, 'accent'));
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
      const afford = price !== null && this.profile.cash >= price;
      ev.push(
        print(
          `  ${pad(item.id, 10)} ${pad(item.name, 18)} ${pad(item.desc, 34)} ${meter} ${owned ? 'MAXED' : `$${price}`}`,
          owned ? 'dim' : afford ? 'good' : 'info'
        )
      );
    }
    ev.push(print('  `buy <id>` — permanent, every future job. modules (free) live in `loadout`.', 'dim'));
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
    if (this.pendingSession) ev.push(print('    (your parked run keeps the rig it started with.)', 'dim'));
    ev.push({ t: 'sfx', name: 'cash' });
    ev.push({ t: 'flash', kind: 'good' });
    ev.push({ t: 'state' });
  }

  /* -------------------------------- records -------------------------------- */

  private printRecords(ev: EngineEvent[]): void {
    ev.push(print('───[ PERSONAL RECORDS — local only ]──────────────', 'accent', 'instant'));
    const campaign: string[] = [];
    for (let i = 1; i <= CONFIG.mission.count; i++) {
      const b = this.bestFor(campaignDescriptor(i));
      if (b) campaign.push(`  #${String(i).padStart(2, '0')} ${pad(CAMPAIGN_CODENAMES[i]!, 15)} ${pad(OUTCOME_LABEL[b.outcome], 16)} $${pad(String(b.cash), 6)} ${pad(b.finalTrace + '%', 5)} ${fmtSeconds(b.activeSeconds)} · ${b.loadoutLabel}`);
    }
    if (campaign.length) {
      ev.push(print('  campaign bests (completed > clean > payout > lower trace > faster):', 'dim'));
      campaign.forEach((l) => ev.push(print(l, 'info')));
    }
    const daily = Object.values(this.daily).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    if (daily.length) {
      ev.push(print('  daily recorded attempts:', 'dim'));
      for (const a of daily) {
        ev.push(print(`  ${a.date}  ${a.status === 'finished' ? `${pad(OUTCOME_LABEL[a.outcome!], 16)} $${a.cash} · ${a.finalTrace}% · ${fmtSeconds(a.activeSeconds ?? 0)}` : a.status}`, 'info'));
      }
    }
    const recent = this.records.recent.slice(0, 8);
    if (recent.length) {
      ev.push(print('  recent runs:', 'dim'));
      for (const r of recent) {
        ev.push(
          print(
            `  ${r.date.slice(0, 10)} ${pad(OUTCOME_LABEL[r.outcome], 16)} $${pad(String(r.cash), 6)} ${pad(r.finalTrace + '%', 5)} ${pad(fmtSeconds(r.activeSeconds), 7)} ${r.label}${r.practice ? ' (practice)' : ''}`,
            r.objectiveComplete ? 'info' : 'dim'
          )
        );
      }
    }
    if (!campaign.length && !daily.length && !recent.length) ev.push(print('  no finished runs yet. records are kept per job and rig.', 'dim'));
  }

  /* --------------------------------- stats --------------------------------- */

  private printStats(ev: EngineEvent[]): void {
    const t = this.profile.telemetry;
    const tg = CONFIG.stats.targets;
    ev.push(print('───[ WIRE ANALYTICS — local self-report ]──────────', 'accent', 'instant'));
    if (t.runsStarted === 0) {
      ev.push(print('  no runs on record. `run 1` and come back. (the tutorial never counts.)', 'dim'));
      return;
    }
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const verdict = (ok: boolean, note: string) => ev.push(print(`      ${ok ? '✓' : '⚠'} ${note}`, ok ? 'good' : 'warn'));
    ev.push(print(`  runs       ${t.runsStarted} started · ${t.runsCompleted} completed · ${t.runsShort} early · ${t.runsBusted} busted · ${t.resumes} resumed`, 'info'));
    if (t.runsEnded > 0) {
      const completion = t.runsCompleted / t.runsEnded;
      ev.push(print(`  completion ${pct(completion)} of finished runs (target ≥${pct(tg.completionRate)})`, 'info'));
      verdict(completion >= tg.completionRate, completion >= tg.completionRate ? 'on target' : 'runs end hot or unfinished');
    }
    if (t.firstBreachCount) {
      const avg = t.firstBreachSum / t.firstBreachCount;
      ev.push(print(`  first hit  ~${Math.round(avg)}s active to first breach (target <${tg.firstBreachMs / 1000}s)`, 'info'));
      verdict(avg < tg.firstBreachMs / 1000, avg < tg.firstBreachMs / 1000 ? 'quick on the wire' : 'slow ramp — cut pre-breach busywork');
    }
    const graded = t.locksSolved + t.locksSkipped;
    if (graded > 0) {
      const skipRate = t.locksSkipped / graded;
      const [lo, hi] = tg.skipRate;
      ev.push(print(`  locks      ${t.locksEncountered} met · ${t.locksSolved} cracked · ${t.locksSkipped} skipped (${pct(skipRate)}) · ${t.lockFailures} failed tries`, 'info'));
      verdict(skipRate >= lo && skipRate <= hi, skipRate < lo ? `below ${pct(lo)} — locks may be too easy` : skipRate > hi ? `above ${pct(hi)} — locks may be too hard` : 'sweet spot');
    }
    const fam = t.failuresByFamily;
    if (Object.values(fam).some((n) => n > 0)) {
      ev.push(print(`  failures   sequence ${fam.sequence ?? 0} · knock ${fam.portknock ?? 0} · cipher ${fam.cipher ?? 0}`, 'info'));
    }
    ev.push(print(`  tools      ${t.hintsBought} hints · ${t.locksSkipped} skips · ${t.proxiesBurned} proxy hops · ${t.decoysBurned} decoys`, 'info'));
    if (t.finalTraceCount) ev.push(print(`  walk-out   avg ${Math.round(t.finalTraceSum / t.finalTraceCount)}% trace at the end`, 'info'));
    const fmtBucket = (k: string, b: OutcomeCounts) => `${k} ${b.completed}✓ ${b.early}↩ ${b.busted}✗ /${b.started}`;
    const contracts = Object.entries(t.byContract).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    if (contracts.length) ev.push(print(`  by job     ${contracts.map(([k, b]) => fmtBucket(k, b)).join(' · ')}`, 'dim'));
    const objs = Object.entries(t.byObjective);
    if (objs.length) ev.push(print(`  by goal    ${objs.map(([k, b]) => fmtBucket(k, b)).join(' · ')}`, 'dim'));
    if (t.sessions > 0) {
      const per = t.runsEnded / t.sessions;
      ev.push(print(`  rhythm     ~${per.toFixed(1)} runs/session over ${t.sessions} session${t.sessions === 1 ? '' : 's'} (target ≥${tg.missionsPerSession})`, 'info'));
      verdict(per >= tg.missionsPerSession, per >= tg.missionsPerSession ? 'they came back' : 'one-and-done risk');
    }
    ev.push(print('  (local counters only — never sent anywhere. targets are playtest goals, not guarantees.)', 'dim'));
  }

  /* ------------------------------- session IO ------------------------------ */

  private snapshotSession(rt: Runtime): SessionSave {
    return {
      v: 2,
      runId: rt.runId,
      descriptor: { ...rt.spec.descriptor },
      draw: { ...rt.spec.draw },
      practice: rt.practice,
      loadout: { module: rt.loadout.module, upgrades: { ...rt.loadout.upgrades } },
      trace: rt.trace,
      peakTrace: rt.peakTrace,
      rngState: rt.rng.getState(),
      tools: { ...rt.tools },
      currentNodeId: rt.currentId,
      cwd: [...rt.cwd],
      breached: [...rt.breached],
      downloaded: [...rt.downloadedTargets],
      removed: [...rt.pulled],
      payloadPlaced: rt.payloadPlaced,
      vaultLooted: rt.vaultLooted,
      scanned: rt.scanned,
      watchdogNodeId: rt.watchdogNodeId,
      watchdogTimer: rt.watchdogTimer,
      decoyTimer: rt.decoyTimer,
      elapsed: rt.elapsed,
      firstBreachAt: rt.firstBreachAt,
      firstBreachKnown: rt.firstBreachKnown,
      tutorialStep: rt.tutorialStep,
      fuseHalf: rt.fuseHalf,
      fuseQuarter: rt.fuseQuarter,
      breakdown: { entries: [...rt.breakdown.entries()], complete: rt.breakdownComplete },
      clueRead: [...rt.clueRead],
      puzzle: rt.puzzle
        ? {
            family: rt.puzzle.family,
            nodeId: rt.puzzle.nodeId,
            timeLimit: rt.puzzle.timeLimit,
            elapsed: rt.puzzle.elapsed,
            attempts: rt.puzzle.attempts,
            forcedSuccess: rt.puzzle.forcedSuccess,
            knock: rt.puzzle.knock ? { entered: [...rt.puzzle.knock.entered], showLeft: Math.max(0, rt.puzzle.knock.showLeft) } : undefined,
            cipherHinted: rt.puzzle.cipher?.hinted,
          }
        : null,
      transfer: rt.transfer ? { op: rt.transfer.op, key: `${rt.transfer.nodeId}|${rt.transfer.path}`, progress: rt.transfer.progress } : null,
      pending: rt.pending ? { remaining: Math.max(0, rt.pending.remaining), action: { ...rt.pending.action } } : null,
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
    rt.peakTrace = Math.max(s.peakTrace ?? 0, s.trace);
    rt.tools = { ...s.tools };
    rt.scanned = s.scanned;
    rt.watchdogNodeId = s.watchdogNodeId;
    rt.watchdogTimer = s.watchdogTimer;
    rt.decoyTimer = s.decoyTimer;
    rt.phase = phaseFor(rt.trace);
    rt.currentId = rt.spec.nodes.some((n) => n.id === s.currentNodeId) ? s.currentNodeId : 'n0';
    for (const id of s.breached) rt.breached.add(id);
    for (const id of s.downloaded) rt.downloadedTargets.add(id);
    rt.payloadPlaced = !!s.payloadPlaced;
    rt.vaultLooted = !!s.vaultLooted;
    rt.sessionCash = s.progress.sessionCash;
    rt.sessionXp = s.progress.sessionXp;
    rt.downloadsCount = s.progress.downloadsCount;
    rt.downloadedValue = s.progress.downloadedValue;
    rt.logsWiped = s.progress.logsWiped;
    rt.elapsed = s.elapsed ?? 0;
    rt.firstBreachAt = s.firstBreachAt ?? null;
    rt.firstBreachKnown = !!s.firstBreachKnown;
    rt.tutorialStep = s.tutorialStep ?? 0;
    rt.fuseHalf = !!s.fuseHalf;
    rt.fuseQuarter = !!s.fuseQuarter;
    rt.breakdown = new Map(s.breakdown?.entries ?? []);
    rt.breakdownComplete = s.breakdown?.complete ?? false;
    rt.clueRead = new Set(s.clueRead ?? []);
    rt.objectiveAnnounced = objectiveDone(rt.spec.objective, { downloadedTargets: rt.downloadedTargets, payloadPlaced: rt.payloadPlaced });
    for (const key of s.removed) {
      rt.pulled.add(key);
      const [nodeId, path] = splitPullKey(key);
      const hit = rt.vfs.get(nodeId)?.resolveFile(path, []);
      if (hit) hit.dir.files = hit.dir.files.filter((f) => f !== hit.file);
    }
    if (rt.payloadPlaced && rt.spec.objective.type === 'payload') {
      const o = rt.spec.objective;
      const dir = rt.vfs.get(o.nodeId)?.resolveDir(o.dir, []);
      if (dir && !dir.files.some((f) => f.tag === 'payload')) dir.files.push({ name: o.payloadName, tag: 'payload' });
    }
    // cwd must still exist on the restored node
    rt.cwd = this.currentVfs(rt).resolveDir('/' + (s.cwd ?? []).join('/'), []) ? [...(s.cwd ?? [])] : [];
    if (s.puzzle) {
      const node = nodeById(rt.spec, s.puzzle.nodeId);
      const answer = rt.spec.puzzleAnswers[s.puzzle.nodeId];
      if (node && answer && node.security > 0 && !rt.breached.has(node.id)) {
        rt.puzzle = instantiatePuzzle(answer, node.id, node.security as 1 | 2 | 3, s.puzzle.timeLimit, s.puzzle.forcedSuccess);
        rt.puzzle.elapsed = s.puzzle.elapsed;
        rt.puzzle.attempts = s.puzzle.attempts;
        if (s.puzzle.knock && rt.puzzle.knock) {
          rt.puzzle.knock.entered = [...s.puzzle.knock.entered];
          // a glow interrupted by closing the tab replays in full — the player was away, not memorizing
          rt.puzzle.knock.showLeft = s.puzzle.knock.showLeft > 0 ? CONFIG.puzzle.knockShowSeconds : 0;
        }
        if (rt.puzzle.cipher && s.puzzle.cipherHinted) rt.puzzle.cipher.hinted = true;
        ev.push(print(`[!] the lock on ${node.hostname} is still open — ${Math.ceil(rt.puzzle.timeLimit - rt.puzzle.elapsed)}s on the fuse:`, 'warn'));
        ev.push(print('    ' + puzzlePrompt(rt.puzzle), 'accent', 'instant'));
        if (rt.puzzle.family === 'portknock' && rt.puzzle.knock!.entered.length) {
          ev.push(print(`    (${rt.puzzle.knock!.entered.length}/${rt.puzzle.knock!.ports.length} knocks already held)`, 'dim'));
        }
        ev.push({ t: 'puzzleOpen', puzzle: puzzleView(rt.puzzle) });
      }
    }
    if (s.transfer) {
      const [nodeId, path] = splitPullKey(s.transfer.key);
      if (s.transfer.op === 'upload' && rt.spec.objective.type === 'payload' && !rt.payloadPlaced) {
        const o = rt.spec.objective;
        const dir = rt.vfs.get(nodeId)?.resolveDir(o.dir, []);
        if (dir) {
          rt.transfer = {
            op: 'upload',
            nodeId,
            dir,
            file: { name: o.payloadName, tag: 'payload' },
            path,
            progress: s.transfer.progress,
            seconds: rt.eff.uploadSeconds,
            nextProgressAt: Math.min(1.01, s.transfer.progress + 0.2),
          };
        }
      } else {
        const hit = rt.vfs.get(nodeId)?.resolveFile(path, []);
        if (hit && (hit.file.tag === 'loot' || hit.file.tag === 'target')) {
          rt.transfer = {
            op: 'download',
            nodeId,
            dir: hit.dir,
            file: hit.file,
            path,
            progress: s.transfer.progress,
            seconds: rt.eff.downloadSeconds,
            nextProgressAt: Math.min(1.01, s.transfer.progress + 0.2),
          };
        }
      }
      if (rt.transfer) ev.push(print(`[»] ${rt.transfer.op} of ${rt.transfer.file.name} resumes at ${Math.floor(rt.transfer.progress * 100)}%.`, 'loot'));
    }
    if (s.pending) {
      // Presentation delays restart briefly instead of being lost.
      rt.pending = { remaining: this.fast ? 0 : Math.min(s.pending.remaining, 0.5), action: { ...s.pending.action } };
      ev.push(print(s.pending.action.type === 'scan' ? '[…] the sweep picks up where it left off…' : '[…] the breach spins back up…', 'dim'));
    }
    if (rt.spec.kind === 'tutorial') {
      this.tutorialGuide(rt, ev, 'Picking up where you left off');
    } else if (!rt.puzzle && this.settings.assist) {
      this.setSuggest(ev, this.coachSuggestion(rt));
    }
    ev.push({ t: 'state' });
  }
}

/* ================================ helpers ================================= */

function phaseFor(trace: number): Phase {
  if (trace >= CONFIG.escalation.alertAt) return 'alert';
  if (trace >= CONFIG.escalation.watchdogAt) return 'watchdog';
  return 'quiet';
}

function shortFamily(f: PuzzleState['family']): string {
  return f === 'portknock' ? 'knock' : f === 'cipher' ? 'cipher' : 'seq';
}

export function rankFor(xp: number): { name: string; xp: number } {
  return CONFIG.ranks[rankIndexForXp(xp)]!;
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

function findPath(dir: DirSpec, file: FileSpec, prefix = '/'): string | null {
  if (dir.files.includes(file)) return prefix + file.name;
  for (const d of dir.dirs ?? []) {
    const hit = findPath(d, file, `${prefix}${d.name}/`);
    if (hit) return hit;
  }
  return null;
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

/** Full normalized absolute path of `arg` resolved against cwd. */
function absPathOf(cwd: string[], arg: string): string {
  const parts = arg.startsWith('/') ? Vfs.splitPath(arg) : [...cwd, ...Vfs.splitPath(arg)];
  return '/' + normalizeParts(parts).join('/');
}

function splitPullKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

function locateFileOnNode(dir: DirSpec, name: string, prefix = '/'): string | null {
  for (const f of dir.files) if (f.name.toLowerCase() === name.toLowerCase()) return prefix + f.name;
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
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

function cloneSpecTree(root: DirSpec): DirSpec {
  return JSON.parse(JSON.stringify(root)) as DirSpec;
}

// re-exported for tests / validator convenience
export { CONFIG, formatSeed, generateMission, contractSeedOf as contractSeed, tutorialMission };
export type { EngineEvent, MissionSpec, Snapshot, SaveBlob };
