/**
 * Deterministic seeded RNG. Every random decision in CyberGrid flows through one
 * of these streams so `same seed = same mission` (PRD §4.3).
 *
 * xmur3 hashes the seed string into a 32-bit state; mulberry32 generates numbers.
 * The generator state is a single uint32, which makes streams trivially serializable
 * for save/resume.
 */
export class Rng {
  private state: number;

  constructor(seed: string, state?: number) {
    this.state = state ?? Rng.hashSeed(seed);
  }

  /** Hash a seed string into a 32-bit starting state (xmur3 finalizer). */
  static hashSeed(seed: string): number {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Fisher–Yates, not mutating the input. */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  getState(): number {
    return this.state >>> 0;
  }
}

/**
 * Format a 64-bit-ish seed as the display style `7F3K-09XA` used across the UI.
 * Deterministic from the input string.
 */
export function formatSeed(seed: string): string {
  const clean = seed.toUpperCase().replace(/[^A-Z0-9]/g, '') || '0000';
  const a = clean.slice(0, 4).padEnd(4, '0');
  const b = clean.slice(4, 8).padEnd(4, '0');
  return `${a}-${b}`;
}
