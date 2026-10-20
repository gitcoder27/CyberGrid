import { CONFIG } from './config.js';
import { contractSeedV1, parseLegacyDraw } from './gen/v1.js';
import { descriptorProblem } from './identity.js';
import { isModuleId } from './equipment.js';
import { generateFor } from './missions.js';
import { fuseBonusFor } from './shop.js';
import { TUTORIAL_STEPS } from './tutorial.js';
import { emptyRecords } from './results.js';
import { Rng } from './rng.js';
import { Vfs } from './vfs.js';
import {
  TELEMETRY_DEFAULT,
  type DailyAttempt,
  type DirSpec,
  type LegacySessionV1,
  type MissionDescriptor,
  type MissionSpec,
  type Profile,
  type RecordEntry,
  type SaveBlob,
  type SessionSave,
  type Settings,
  type Telemetry,
} from './types.js';

/**
 * Save schema v2 and migration (F02, F03, compatibility requirements).
 *
 * - v1 blobs (`cybergrid.save.v1`) migrate without resetting cash, XP,
 *   purchases, cleared contracts, settings or history.
 * - A legacy active session is rebuilt against the frozen generation-1
 *   generator (never regenerated with new rules), its fuse limits are
 *   recomputed from the owned crowbar level, and basename-only file keys
 *   written by the old engine are resolved to real paths.
 * - Anything that cannot be rebuilt is kept as `brokenSession` with a reason,
 *   so the player sees a message and can explicitly `abandon` it.
 */

export const SAVE_VERSION = 2;

export const SETTINGS_DEFAULT: Settings = { volume: 0.8, muted: false, crt: true, motion: true, typing: true, assist: true };

export function defaultProfile(): Profile {
  return {
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
}

export function freshTelemetry(): Telemetry {
  return { ...TELEMETRY_DEFAULT, byContract: {}, byObjective: {}, failuresByFamily: {} };
}

export function defaultSave(): SaveBlob {
  return {
    version: 2,
    profile: defaultProfile(),
    settings: { ...SETTINGS_DEFAULT },
    history: [],
    session: null,
    records: emptyRecords(),
    daily: {},
    brokenSession: null,
  };
}

export interface MigrationReport {
  blob: SaveBlob;
  from: 0 | 1 | 2;
  notes: string[];
}

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const strArr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);

/** Accept anything; return a valid v2 blob plus what happened. Never throws. */
export function migrateSave(raw: unknown): MigrationReport {
  if (raw === null || raw === undefined) return { blob: defaultSave(), from: 0, notes: [] };
  if (!isObj(raw)) return { blob: defaultSave(), from: 0, notes: ['save data was unreadable; started a fresh burner.'] };
  if (raw.version === 1) return migrateV1(raw);
  if (raw.version === 2) return { ...sanitizeV2(raw), from: 2 };
  return { blob: defaultSave(), from: 0, notes: [`save version ${String(raw.version)} is not supported; started fresh.`] };
}

function sanitizeProfile(p: unknown): Profile {
  const src = isObj(p) ? p : {};
  const upgrades: Record<string, number> = {};
  if (isObj(src.upgrades)) {
    for (const item of CONFIG.shop.items) {
      const lv = num(src.upgrades[item.id], 0);
      if (lv > 0) upgrades[item.id] = Math.min(item.maxLevel, Math.floor(lv));
    }
  }
  const t = isObj(src.telemetry) ? src.telemetry : {};
  const telemetry = freshTelemetry();
  for (const k of Object.keys(TELEMETRY_DEFAULT) as (keyof Telemetry)[]) {
    const def = TELEMETRY_DEFAULT[k];
    if (typeof def === 'number') (telemetry as unknown as Record<string, number>)[k] = num(t[k], def);
  }
  for (const k of ['byContract', 'byObjective'] as const) {
    if (isObj(t[k])) {
      for (const [key, v] of Object.entries(t[k] as Record<string, unknown>).slice(0, 32)) {
        if (isObj(v)) {
          telemetry[k][key] = { started: num(v.started, 0), completed: num(v.completed, 0), early: num(v.early, 0), busted: num(v.busted, 0) };
        }
      }
    }
  }
  if (isObj(t.failuresByFamily)) {
    for (const fam of ['sequence', 'portknock', 'cipher']) telemetry.failuresByFamily[fam] = num(t.failuresByFamily[fam], 0);
  }
  const contractsDone = Math.max(0, Math.min(CONFIG.mission.count, Math.floor(num(src.contractsDone, 0))));
  const campaignComplete = bool(src.campaignComplete, contractsDone >= CONFIG.mission.count) || contractsDone >= CONFIG.mission.count;
  return {
    cash: Math.max(0, num(src.cash, 0)),
    xp: Math.max(0, num(src.xp, 0)),
    contractsDone,
    tutorialDone: bool(src.tutorialDone, false),
    upgrades,
    telemetry,
    equipped: isModuleId(src.equipped) ? src.equipped : null,
    campaignComplete,
    endingSeen: bool(src.endingSeen, false),
  };
}

function sanitizeSettings(s: unknown): Settings {
  const src = isObj(s) ? s : {};
  return {
    volume: Math.max(0, Math.min(1, num(src.volume, SETTINGS_DEFAULT.volume))),
    muted: bool(src.muted, SETTINGS_DEFAULT.muted),
    crt: bool(src.crt, SETTINGS_DEFAULT.crt),
    motion: bool(src.motion, SETTINGS_DEFAULT.motion),
    typing: bool(src.typing, SETTINGS_DEFAULT.typing),
    assist: bool(src.assist, SETTINGS_DEFAULT.assist),
  };
}

function sanitizeRecords(r: unknown): SaveBlob['records'] {
  const out = emptyRecords();
  if (!isObj(r)) return out;
  const valid = (e: unknown): e is RecordEntry =>
    isObj(e) && typeof e.runId === 'string' && typeof e.key === 'string' && typeof e.outcome === 'string' && typeof e.date === 'string';
  if (isObj(r.best)) {
    for (const [k, v] of Object.entries(r.best).slice(0, CONFIG.records.bestMax)) if (valid(v)) out.best[k] = v;
  }
  if (Array.isArray(r.recent)) out.recent = r.recent.filter(valid).slice(0, CONFIG.records.recentMax);
  return out;
}

function sanitizeDaily(d: unknown): Record<string, DailyAttempt> {
  const out: Record<string, DailyAttempt> = {};
  if (!isObj(d)) return out;
  const dates = Object.keys(d).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-CONFIG.daily.keepDays);
  for (const date of dates) {
    const a = d[date];
    if (isObj(a) && typeof a.runId === 'string' && ['live', 'finished', 'abandoned'].includes(String(a.status))) {
      out[date] = { ...(a as unknown as DailyAttempt), date };
    }
  }
  return out;
}

function sanitizeV2(raw: Record<string, unknown>): { blob: SaveBlob; notes: string[] } {
  const notes: string[] = [];
  const blob: SaveBlob = {
    version: 2,
    profile: sanitizeProfile(raw.profile),
    settings: sanitizeSettings(raw.settings),
    history: strArr(raw.history).slice(-100),
    session: null,
    records: sanitizeRecords(raw.records),
    daily: sanitizeDaily(raw.daily),
    brokenSession: isObj(raw.brokenSession)
      ? { reason: String(raw.brokenSession.reason ?? 'unknown'), label: String(raw.brokenSession.label ?? 'a parked run'), raw: raw.brokenSession.raw }
      : null,
  };
  if (raw.session !== null && raw.session !== undefined) {
    const problem = sessionProblem(raw.session);
    if (problem) {
      blob.brokenSession = { reason: problem, label: labelOf(raw.session), raw: raw.session };
      notes.push(`the parked run could not be rebuilt (${problem}).`);
    } else {
      blob.session = raw.session as SessionSave;
    }
  }
  return { blob, notes };
}

function labelOf(s: unknown): string {
  if (!isObj(s)) return 'a parked run';
  const d = isObj(s.descriptor) ? s.descriptor : null;
  if (d) return `${String(d.mode)} ${String(d.seed)}`;
  return `${String(s.kind ?? 'run')} ${String(s.seed ?? '')}`.trim();
}

/** Structural check for a v2 session, including that its mission can be rebuilt. */
export function sessionProblem(s: unknown): string | null {
  if (!isObj(s) || s.v !== 2) return 'unknown session format';
  if (!isObj(s.descriptor) || !isObj(s.draw)) return 'missing mission identity';
  const d = s.descriptor as unknown as MissionDescriptor;
  if (d.mode !== 'tutorial') {
    const p = descriptorProblem(d);
    if (p) return p;
  }
  if (typeof s.trace !== 'number' || !Number.isFinite(s.trace)) return 'missing trace';
  if (!Array.isArray(s.breached) || typeof s.currentNodeId !== 'string') return 'missing position';
  try {
    const spec = generateFor(d, String((s.draw as Record<string, unknown>).seed), num((s.draw as Record<string, unknown>).relax, 0));
    if (!spec.nodes.some((n) => n.id === s.currentNodeId)) return 'saved position is not on that network';
  } catch {
    return 'mission could not be regenerated';
  }
  return null;
}

/* ------------------------------- v1 → v2 -------------------------------- */

function migrateV1(raw: Record<string, unknown>): MigrationReport {
  const notes: string[] = ['save migrated from v1 — progress, purchases and settings kept.'];
  const profile = sanitizeProfile(raw.profile);
  // A legacy finisher never saw an ending (it didn't exist). Don't force it on
  // them; the board offers `epilogue` instead.
  const blob: SaveBlob = {
    version: 2,
    profile,
    settings: sanitizeSettings(raw.settings),
    history: strArr(raw.history).slice(-100),
    session: null,
    records: emptyRecords(),
    daily: {},
    brokenSession: null,
  };
  if (raw.session) {
    const res = convertLegacySession(raw.session as LegacySessionV1, profile, strArr(raw.history));
    if ('error' in res) {
      blob.brokenSession = { reason: res.error, label: labelOf(raw.session), raw: raw.session };
      notes.push(`the parked legacy run could not be rebuilt (${res.error}) — \`abandon\` clears it.`);
    } else {
      blob.session = res.session;
      notes.push('a legacy run in progress was kept — `resume` puts you back on it.');
    }
  }
  return { blob, from: 1, notes };
}

function legacyDescriptor(s: LegacySessionV1): MissionDescriptor {
  if (s.kind === 'tutorial') {
    return { gen: 2, mode: 'tutorial', seed: CONFIG.tutorial.seed, tier: 0, topology: 'chain', objective: 'flagged', modifier: null };
  }
  const { original } = parseLegacyDraw(s.seed);
  const campaign = original === contractSeedV1(s.index);
  return { gen: 1, mode: campaign ? 'campaign' : 'custom', seed: original, tier: s.index, topology: 'chain', objective: 'flagged', modifier: null };
}

/** Locate a legacy pull key (`node|/basename` or a real path) on the spec. */
function resolveLegacyKey(spec: MissionSpec, key: string): string | null {
  const i = key.indexOf('|');
  if (i < 0) return null;
  const nodeId = key.slice(0, i);
  const path = key.slice(i + 1);
  const node = spec.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const vfs = new Vfs(node.root);
  if (vfs.resolveFile(path, [])) return `${nodeId}|${path}`;
  const base = path.split('/').pop() ?? path;
  const hit = findByBasename(node.root, base);
  return hit ? `${nodeId}|${hit}` : null;
}

function findByBasename(dir: DirSpec, name: string, prefix = '/'): string | null {
  for (const f of dir.files) if (f.name === name) return prefix + f.name;
  for (const d of dir.dirs ?? []) {
    const hit = findByBasename(d, name, `${prefix}${d.name}/`);
    if (hit) return hit;
  }
  return null;
}

/** Derive the tutorial step from restored progress (legacy saves never stored it). */
export function deriveTutorialStep(s: {
  scanned: boolean;
  breached: string[];
  downloaded: string[];
  logsWiped: number;
  puzzleOpen: boolean;
  transferring: boolean;
  cwd: string[];
}): number {
  const idx = (marker: string) => TUTORIAL_STEPS.findIndex((st) => st.advanceOn === marker);
  if (s.logsWiped > 0) return idx('disconnect');
  if (s.downloaded.length > 0) return idx('rm-log');
  if (s.transferring) return idx('download-complete');
  if (s.breached.includes('n1')) return s.cwd.join('/') === 'srv' ? idx('download-complete') : idx('ls');
  if (s.puzzleOpen) return idx('input');
  if (s.scanned) return idx('breach');
  return 0;
}

/**
 * Legacy sessions never stored the working directory. Replay the `cd`
 * commands typed since the session last changed node (breach/connect/resume)
 * against that node's tree; fall back to `/`.
 */
function inferLegacyCwd(history: string[], root: DirSpec): string[] {
  let start = 0;
  history.forEach((line, i) => {
    if (/^(breach|exploit|connect|ssh|hop|run|tutorial|resume)\b/i.test(line.trim())) start = i + 1;
  });
  const vfs = new Vfs(root);
  let cwd: string[] = [];
  for (const line of history.slice(start)) {
    const m = /^cd(?:\s+(.*))?$/i.exec(line.trim());
    if (!m) continue;
    const arg = (m[1] ?? '').trim();
    if (!arg) {
      cwd = [];
      continue;
    }
    if (!vfs.resolveDir(arg, cwd)) continue;
    const parts = arg.startsWith('/') ? Vfs.splitPath(arg) : [...cwd, ...Vfs.splitPath(arg)];
    const out: string[] = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    cwd = out;
  }
  return cwd;
}

export function convertLegacySession(
  s: LegacySessionV1,
  profile: Profile,
  history: string[] = []
): { session: SessionSave } | { error: string } {
  try {
    if (!s || typeof s !== 'object' || typeof s.seed !== 'string' || typeof s.trace !== 'number') {
      return { error: 'incomplete legacy session' };
    }
    const descriptor = legacyDescriptor(s);
    const { relax } = parseLegacyDraw(s.seed);
    const draw = { seed: s.kind === 'tutorial' ? CONFIG.tutorial.seed : s.seed, relax: s.kind === 'tutorial' ? 0 : relax };
    if (descriptor.mode !== 'tutorial' && (s.index < 1 || s.index > CONFIG.mission.count)) return { error: 'contract index out of range' };
    const spec = generateFor(descriptor, draw.seed, draw.relax);
    if (!spec.nodes.some((n) => n.id === s.currentNodeId)) return { error: 'saved position is not on that network' };

    const removed = (s.removed ?? []).map((k) => resolveLegacyKey(spec, k)).filter((k): k is string => !!k);
    let transfer: SessionSave['transfer'] = null;
    if (s.transfer) {
      const key = resolveLegacyKey(spec, s.transfer.fileId);
      if (key) transfer = { op: 'download', key, progress: Math.max(0, Math.min(1, num(s.transfer.progress, 0))) };
    }
    let puzzle: SessionSave['puzzle'] = null;
    let fuseHalf = false;
    let fuseQuarter = false;
    if (s.puzzle) {
      const node = spec.nodes.find((n) => n.id === s.puzzle!.nodeId);
      if (!node || node.security === 0) return { error: 'saved lock is not on that network' };
      // Effective fuse = base + the crowbar the player owned (the old resume dropped it).
      const timeLimit =
        CONFIG.puzzle.timeBoxBySecurity[node.security]! + (s.kind === 'tutorial' ? 0 : fuseBonusFor(profile));
      const elapsed = Math.max(0, num(s.puzzle.elapsed, 0));
      const left = timeLimit - elapsed;
      fuseHalf = left <= timeLimit / 2;
      fuseQuarter = left <= timeLimit / 4;
      puzzle = {
        family: s.puzzle.family,
        nodeId: s.puzzle.nodeId,
        timeLimit,
        elapsed,
        attempts: Math.max(0, num(s.puzzle.attempts, 0)),
        forcedSuccess: !!s.puzzle.forcedSuccess,
        knock: s.puzzle.knock ? { entered: [...(s.puzzle.knock.entered ?? [])], showLeft: Math.max(0, num(s.puzzle.knock.showLeft, 0)) } : undefined,
        cipherHinted: s.puzzle.cipher?.hinted ?? false,
      };
    }
    const breached = Array.from(new Set(['n0', ...(s.breached ?? [])]));
    const cwd = s.puzzle ? [] : inferLegacyCwd(history, spec.nodes.find((n) => n.id === s.currentNodeId)!.root);
    const downloaded = [...(s.downloaded ?? [])];
    const logsWiped = num(s.progress?.logsWiped, 0);
    const session: SessionSave = {
      v: 2,
      runId: `legacy-${Rng.hashSeed(JSON.stringify(s)).toString(36)}`,
      descriptor,
      draw,
      practice: false,
      loadout: { module: null, upgrades: descriptor.mode === 'tutorial' ? {} : { ...profile.upgrades } },
      trace: Math.max(0, num(s.trace, 0)),
      peakTrace: Math.max(0, num(s.trace, 0)),
      rngState: num(s.rngState, 0) >>> 0,
      tools: { proxy: num(s.tools?.proxy, 0), decoy: num(s.tools?.decoy, 0) },
      currentNodeId: s.currentNodeId,
      cwd,
      breached,
      downloaded,
      removed,
      payloadPlaced: false,
      vaultLooted: false,
      scanned: !!s.scanned,
      watchdogNodeId: s.watchdogNodeId ?? null,
      watchdogTimer: num(s.watchdogTimer, CONFIG.tools.watchdogMoveSeconds),
      decoyTimer: num(s.decoyTimer, 0),
      elapsed: 0,
      firstBreachAt: null,
      // Breaches already happened before the save but their timing wasn't kept:
      // never sample a misleading first-breach time later.
      firstBreachKnown: breached.length > 1,
      tutorialStep:
        s.kind === 'tutorial'
          ? deriveTutorialStep({
              scanned: !!s.scanned,
              breached,
              downloaded,
              logsWiped,
              puzzleOpen: !!s.puzzle,
              transferring: !!transfer,
              cwd,
            })
          : 0,
      fuseHalf,
      fuseQuarter,
      breakdown: { entries: s.trace > 0 ? [['unrecorded', s.trace]] : [], complete: s.trace <= 0 },
      clueRead: [],
      puzzle,
      transfer,
      pending: null,
      progress: {
        sessionCash: num(s.progress?.sessionCash, 0),
        sessionXp: num(s.progress?.sessionXp, 0),
        downloadsCount: num(s.progress?.downloadsCount, 0),
        downloadedValue: num(s.progress?.downloadedValue, 0),
        logsWiped,
      },
    };
    return { session };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'unknown failure' };
  }
}
