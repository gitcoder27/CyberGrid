import { CONFIG } from './config.js';

/**
 * The Broker's market (PRD §10 lite): cash buys persistent upgrades whose
 * effects apply to every job. Pure functions — the engine reads these wherever
 * a base CONFIG value gets scaled by owned levels.
 */

export interface ProfileLike {
  upgrades: Record<string, number>;
}

export function shopItem(id: string) {
  return CONFIG.shop.items.find((i) => i.id === id) ?? null;
}

export function upgradeLevel(profile: ProfileLike, id: string): number {
  const level = profile.upgrades[id] ?? 0;
  const item = shopItem(id);
  if (!item) return 0;
  return Math.max(0, Math.min(item.maxLevel, level));
}

export function upgradeCost(id: string, currentLevel: number): number {
  const item = shopItem(id);
  if (!item) return Infinity;
  return Math.round(item.baseCost * Math.pow(CONFIG.shop.costMultiplier, currentLevel));
}

/* ------------------------- per-job effective values ------------------------ */

export function proxyHopsFor(profile: ProfileLike): number {
  return CONFIG.tools.proxyHopsPerMission + upgradeLevel(profile, 'relay');
}

export function decoysFor(profile: ProfileLike): number {
  return CONFIG.tools.decoysPerMission + upgradeLevel(profile, 'drone');
}

/** Transfer time per file; also proportionally less download trace. */
export function transferSecondsFor(profile: ProfileLike): number {
  const reduction = 0.15 * upgradeLevel(profile, 'overclock');
  return CONFIG.download.secondsPerFile * (1 - reduction);
}

/** Multiplier on the idle creep rate. */
export function idleRateFactor(profile: ProfileLike): number {
  return 1 - 0.2 * upgradeLevel(profile, 'ghosting');
}

export function fuseBonusFor(profile: ProfileLike): number {
  return 8 * upgradeLevel(profile, 'crowbar');
}

export function hintCostFor(profile: ProfileLike): number {
  return upgradeLevel(profile, 'insider')
    ? Math.round(CONFIG.puzzle.hintCost * 0.6)
    : CONFIG.puzzle.hintCost;
}
