import type { SaveBlob, StorageAdapter } from '@cybergrid/engine';

/**
 * localStorage adapter (PRD §4.3). The engine owns schema migration; this
 * adapter only finds the newest data and never destroys the old copy:
 *
 * - `cybergrid.save.v2` is the live save.
 * - `cybergrid.save.v1` (older builds) is read when no v2 save exists and is
 *   left in place as a backup after migration.
 * - A v2 save that fails to parse is copied to `cybergrid.save.corrupt` before
 *   anything overwrites it.
 */
export const SAVE_KEY = 'cybergrid.save.v2';
export const LEGACY_KEY = 'cybergrid.save.v1';
export const CORRUPT_KEY = 'cybergrid.save.corrupt';

export function createLocalStorageAdapter(store: Storage | null = safeLocalStorage()): StorageAdapter {
  return {
    load(): unknown {
      if (!store) return null;
      const read = (key: string): { ok: true; value: unknown } | { ok: false; raw: string } | null => {
        const raw = store.getItem(key);
        if (raw === null) return null;
        try {
          return { ok: true, value: JSON.parse(raw) };
        } catch {
          return { ok: false, raw };
        }
      };
      try {
        const current = read(SAVE_KEY);
        if (current?.ok) return current.value;
        if (current && !current.ok) {
          store.setItem(CORRUPT_KEY, current.raw);
          const legacy = read(LEGACY_KEY);
          // Unreadable v2 → the engine starts fresh with a note; the raw text is kept.
          return legacy?.ok ? legacy.value : 'unreadable';
        }
        const legacy = read(LEGACY_KEY);
        if (legacy?.ok) return legacy.value;
        if (legacy && !legacy.ok) {
          store.setItem(CORRUPT_KEY, legacy.raw);
          return 'unreadable';
        }
        return null;
      } catch {
        return null;
      }
    },
    save(blob: SaveBlob): void {
      try {
        store?.setItem(SAVE_KEY, JSON.stringify(blob));
      } catch {
        // storage full or blocked — the game never depends on persistence
      }
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
