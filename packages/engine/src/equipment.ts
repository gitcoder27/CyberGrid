import { CONFIG, type ModuleDef } from './config.js';
import {
  decoysFor,
  fuseBonusFor,
  hintCostFor,
  idleRateFactor,
  proxyHopsFor,
  upgradeLevel,
} from './shop.js';
import type { Loadout, ModifierId, ModuleId, Profile } from './types.js';

/**
 * Equipment (E03): one optional module slot on top of the permanent shop
 * upgrades. A run freezes its loadout at start, so resume, records, and the
 * daily challenge's fixed rig all read the same numbers from here.
 */

export function moduleDef(id: string): ModuleDef | null {
  return CONFIG.modules.find((m) => m.id === id) ?? null;
}

export function rankIndex(name: string): number {
  return CONFIG.ranks.findIndex((r) => r.name === name);
}

export function rankIndexForXp(xp: number): number {
  let idx = 0;
  CONFIG.ranks.forEach((r, i) => {
    if (xp >= r.xp) idx = i;
  });
  return idx;
}

export function moduleUnlocked(id: string, xp: number): boolean {
  const m = moduleDef(id);
  return !!m && rankIndexForXp(xp) >= rankIndex(m.unlockRank);
}

/** Modules whose unlock rank lies in (xpBefore, xpAfter]. */
export function unlocksBetween(xpBefore: number, xpAfter: number): ModuleDef[] {
  const a = rankIndexForXp(xpBefore);
  const b = rankIndexForXp(xpAfter);
  return CONFIG.modules.filter((m) => rankIndex(m.unlockRank) > a && rankIndex(m.unlockRank) <= b);
}

/** The loadout a run would start with right now. */
export function profileLoadout(profile: Pick<Profile, 'equipped' | 'upgrades' | 'xp'>): Loadout {
  const module = profile.equipped && moduleUnlocked(profile.equipped, profile.xp) ? profile.equipped : null;
  const upgrades: Record<string, number> = {};
  for (const item of CONFIG.shop.items) {
    const lv = upgradeLevel(profile, item.id);
    if (lv > 0) upgrades[item.id] = lv;
  }
  return { module, upgrades };
}

export function starterLoadout(): Loadout {
  return { module: null, upgrades: {} };
}

export interface Effective {
  proxy: number;
  decoy: number;
  downloadSeconds: number;
  uploadSeconds: number;
  /** Multiplier on transfer trace rates (module × modifier). */
  transferTraceFactor: number;
  idleFactor: number;
  fuseBonus: number;
  hintCost: number;
  watchdogMoveSeconds: number;
}

export function effectiveFor(loadout: Loadout, modifier: ModifierId | null): Effective {
  const mod = loadout.module ? moduleDef(loadout.module) : null;
  const overclock = 1 - 0.15 * upgradeLevel(loadout, 'overclock');
  const noisy = modifier === 'noisy' ? CONFIG.modifiers.noisy.transferTraceMultiplier : 1;
  const patrol = modifier === 'patrol' ? CONFIG.modifiers.patrol.watchdogMoveMultiplier : 1;
  return {
    proxy: proxyHopsFor(loadout),
    decoy: decoysFor(loadout),
    downloadSeconds: CONFIG.download.secondsPerFile * overclock * (mod?.transferDuration ?? 1),
    uploadSeconds: CONFIG.upload.secondsPerFile * overclock * (mod?.transferDuration ?? 1),
    transferTraceFactor: (mod?.transferTraceRate ?? 1) * noisy,
    idleFactor: idleRateFactor(loadout),
    fuseBonus: fuseBonusFor(loadout),
    hintCost: hintCostFor(loadout),
    watchdogMoveSeconds: CONFIG.tools.watchdogMoveSeconds * patrol,
  };
}

/** Total trace one download costs under a loadout (shown before a job starts). */
export function downloadTraceFor(loadout: Loadout, modifier: ModifierId | null = null): number {
  const e = effectiveFor(loadout, modifier);
  return CONFIG.trace.downloadPerSecond * e.transferTraceFactor * e.downloadSeconds;
}

export function loadoutLabel(loadout: Loadout): string {
  const mod = loadout.module ? moduleDef(loadout.module)?.name ?? loadout.module : 'no module';
  const ups = Object.entries(loadout.upgrades)
    .filter(([, lv]) => lv > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, lv]) => `${id}${lv}`)
    .join(' ');
  return ups ? `${mod} · ${ups}` : `${mod} · stock rig`;
}

/** Comparable-records bucket for a loadout. */
export function loadoutKey(loadout: Loadout): string {
  const ups = Object.entries(loadout.upgrades)
    .filter(([, lv]) => lv > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, lv]) => `${id}${lv}`)
    .join(',');
  return `${loadout.module ?? 'none'}/${ups || 'stock'}`;
}

export function isModuleId(x: unknown): x is ModuleId {
  return x === 'burst' || x === 'quiet';
}
