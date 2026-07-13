/**
 * Persistence for the discarded/saved/pin-override stores, behind a
 * pluggable backend so the storage mechanism can be swapped without
 * touching useFeed:
 *
 *  - Standalone web app (this build): localStorage.
 *  - Environments without localStorage (private mode, artifacts): falls
 *    back to an in-memory Map automatically — the app keeps working,
 *    state just doesn't survive a reload. An artifact build would supply
 *    a window.storage-backed StorageBackend here instead.
 */

export interface StorageBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

function createMemoryBackend(): StorageBackend {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
  };
}

function createLocalStorageBackend(): StorageBackend | null {
  try {
    const probe = "swipe-reader:probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
    };
  } catch {
    return null;
  }
}

const backend: StorageBackend =
  createLocalStorageBackend() ?? createMemoryBackend();

const PREFIX = "swipe-reader:";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = backend.get(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save<T>(key: string, value: T): void {
  try {
    backend.set(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — the app still works, state just
    // won't survive a reload.
  }
}
