import type { SaveBlob } from '@cybergrid/engine';

const KEY = 'cybergrid.save.v1';

/** localStorage adapter for the engine's save system (PRD §4.3). */
export const localStorageAdapter = {
  load(): SaveBlob | null {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return null;
      const blob = JSON.parse(raw) as SaveBlob;
      if (blob.version !== 1) return null;
      return blob;
    } catch {
      return null;
    }
  },
  save(blob: SaveBlob): void {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(blob));
    } catch {
      // storage full or blocked — the game never depends on persistence
    }
  },
};
