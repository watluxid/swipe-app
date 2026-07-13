/**
 * Thin localStorage persistence for the discarded/saved stores.
 * Kept behind load/save helpers so the storage backend could be swapped
 * (IndexedDB, remote sync) without touching the hook that uses it.
 */

const PREFIX = "swipe-reader:";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable (private mode) — the app still works,
    // state just won't survive a reload.
  }
}
