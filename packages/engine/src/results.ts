import { CONFIG } from './config.js';
import { descriptorKey } from './identity.js';
import { loadoutKey } from './equipment.js';
import type { ExitQuality, Loadout, MissionDescriptor, MissionOutcome, ModifierId, RecordEntry, RecordsState } from './types.js';

/**
 * Scoring and personal records (F05, E04). Objective completion and exit
 * quality are separate facts: a clean disconnect with the job unfinished is
 * EXTRACTED EARLY, never a success, and earns no completion bonuses.
 */

export interface ScoreInput {
  ended: 'disconnect' | 'busted';
  /** Authoritative (unrounded) trace at the end. */
  traceExact: number;
  objectiveComplete: boolean;
  lootCash: number;
  sessionXp: number;
  logsWiped: number;
  descriptor: MissionDescriptor;
  practice: boolean;
  modifier: ModifierId | null;
}

export interface Score {
  outcome: MissionOutcome;
  exit: ExitQuality;
  cash: number;
  xp: number;
  lootCash: number;
  cleanBonus: number;
  missionBonus: number;
  modifierBonus: number;
  logCash: number;
}

export function exitQualityFor(traceExact: number): 'clean' | 'hot' {
  return traceExact < CONFIG.trace.cleanExitUnder ? 'clean' : 'hot';
}

export function bonusFactor(d: MissionDescriptor, practice: boolean): number {
  switch (d.mode) {
    case 'campaign':
      return CONFIG.modes.campaignBonusFactor;
    case 'custom':
      return CONFIG.modes.customBonusFactor;
    case 'daily':
      return practice ? CONFIG.modes.dailyPracticeBonusFactor : CONFIG.modes.dailyBonusFactor;
    default:
      return 0;
  }
}

export function missionBonusFor(d: MissionDescriptor, practice: boolean): number {
  if (d.mode === 'tutorial') return 0;
  const base = CONFIG.economy.missionBonus[Math.min(d.tier, CONFIG.economy.missionBonus.length - 1)]!;
  return Math.round(base * bonusFactor(d, practice));
}

export function scoreRun(s: ScoreInput): Score {
  const zero = { cleanBonus: 0, missionBonus: 0, modifierBonus: 0, logCash: 0 };
  if (s.ended === 'busted') {
    return {
      outcome: 'busted',
      exit: 'busted',
      cash: 0,
      xp: Math.round(s.sessionXp * CONFIG.economy.bustedXpFactor),
      lootCash: 0,
      ...zero,
    };
  }
  const exit = exitQualityFor(s.traceExact);
  if (!s.objectiveComplete) {
    // Partial extraction keeps what was actually taken and the work done —
    // no clean multiplier, no log bounty, no contract or hazard bonus.
    return { outcome: 'early', exit, cash: Math.round(s.lootCash), xp: Math.round(s.sessionXp), lootCash: Math.round(s.lootCash), ...zero };
  }
  const clean = exit === 'clean';
  const cleanBonus = clean ? Math.round(s.lootCash * (CONFIG.economy.cleanMultiplier - 1)) : 0;
  const logCash = s.logsWiped * CONFIG.economy.cashPerLog;
  const missionBonus = missionBonusFor(s.descriptor, s.practice);
  const modifierBonus = s.modifier && s.descriptor.mode !== 'tutorial' ? CONFIG.modifiers[s.modifier].bonus : 0;
  const cash = Math.round(s.lootCash) + cleanBonus + logCash + missionBonus + modifierBonus;
  const xp = Math.round(s.sessionXp) + CONFIG.economy.xpObjective + (clean ? CONFIG.economy.xpCleanBonus : 0);
  return { outcome: exit, exit, cash, xp, lootCash: Math.round(s.lootCash), cleanBonus, missionBonus, modifierBonus, logCash };
}

export const OUTCOME_LABEL: Record<MissionOutcome, string> = {
  clean: 'CLEAN EXIT',
  hot: 'HOT EXIT',
  early: 'EXTRACTED EARLY',
  busted: 'BUSTED',
};

/* --------------------------------- records -------------------------------- */

export function recordKey(d: MissionDescriptor, loadout: Loadout, practice: boolean): string {
  const slot = d.mode === 'daily' ? (practice ? 'practice' : 'recorded') : 'run';
  return `r${CONFIG.rulesVersion}|${descriptorKey(d)}|${loadoutKey(loadout)}|${slot}`;
}

const OUTCOME_RANK: Record<MissionOutcome, number> = { clean: 0, hot: 1, early: 2, busted: 3 };

/** Negative when `a` is the better result. Ties return 0 (the earlier result stays). */
export function compareRecords(a: RecordEntry, b: RecordEntry): number {
  if (a.objectiveComplete !== b.objectiveComplete) return a.objectiveComplete ? -1 : 1;
  if (OUTCOME_RANK[a.outcome] !== OUTCOME_RANK[b.outcome]) return OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome];
  if (a.cash !== b.cash) return b.cash - a.cash;
  if (a.finalTrace !== b.finalTrace) return a.finalTrace - b.finalTrace;
  if (a.activeSeconds !== b.activeSeconds) return a.activeSeconds - b.activeSeconds;
  return 0;
}

export function emptyRecords(): RecordsState {
  return { best: {}, recent: [] };
}

/**
 * Store a finished run once. Returns whether it became the new best for its
 * bucket and what it beat. Re-submitting the same runId is a no-op.
 */
export function recordRun(
  state: RecordsState,
  entry: RecordEntry
): { state: RecordsState; newBest: boolean; previous: RecordEntry | null; duplicate: boolean } {
  if (state.recent.some((r) => r.runId === entry.runId) || Object.values(state.best).some((r) => r.runId === entry.runId)) {
    return { state, newBest: false, previous: state.best[entry.key] ?? null, duplicate: true };
  }
  const previous = state.best[entry.key] ?? null;
  const newBest = !previous || compareRecords(entry, previous) < 0;
  const best = { ...state.best };
  if (newBest) best[entry.key] = entry;
  const keys = Object.keys(best);
  if (keys.length > CONFIG.records.bestMax) {
    keys
      .sort((x, y) => best[x]!.date.localeCompare(best[y]!.date))
      .slice(0, keys.length - CONFIG.records.bestMax)
      .forEach((k) => delete best[k]);
  }
  const recent = [entry, ...state.recent].slice(0, CONFIG.records.recentMax);
  return { state: { best, recent }, newBest, previous, duplicate: false };
}
