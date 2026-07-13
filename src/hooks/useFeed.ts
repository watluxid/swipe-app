import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscardedStore, FeedItem, SavedStore } from "../types";
import { getFeedItems } from "../data/adapter";
import { load, save } from "../store/persistence";

interface UseFeedOptions {
  /**
   * Refresh strategy: when set, refreshFeed() is re-run on this interval
   * (ms). Off by default — pointless for a static fixture, but ready for
   * a remote adapter that gets new items over time.
   */
  pollInterval?: number;
}

export interface Feed {
  /** Undiscarded, unsaved items: pinned first, then newest first. */
  queue: FeedItem[];
  saved: SavedStore;
  loading: boolean;
  error: string | null;
  refreshFeed: () => Promise<void>;
  discard: (item: FeedItem) => void;
  saveItem: (item: FeedItem) => void;
  unsave: (id: string) => void;
  togglePinned: (id: string) => void;
}

function sortQueue(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.date.localeCompare(a.date);
  });
}

export function useFeed({ pollInterval }: UseFeedOptions = {}): Feed {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [discarded, setDiscarded] = useState<DiscardedStore>(() =>
    load("discarded", {}),
  );
  const [saved, setSaved] = useState<SavedStore>(() => load("saved", {}));
  // Local overrides for the source-provided pinned flag, keyed by id.
  const [pinOverrides, setPinOverrides] = useState<Record<string, boolean>>(
    () => load("pinOverrides", {}),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => save("discarded", discarded), [discarded]);
  useEffect(() => save("saved", saved), [saved]);
  useEffect(() => save("pinOverrides", pinOverrides), [pinOverrides]);

  const refreshFeed = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await getFeedItems();
      // Dedupe by id — a refresh may return items we already have.
      const byId = new Map(fetched.map((item) => [item.id, item]));
      setItems([...byId.values()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load feed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshFeed();
  }, [refreshFeed]);

  useEffect(() => {
    if (!pollInterval) return;
    const id = setInterval(() => void refreshFeed(), pollInterval);
    return () => clearInterval(id);
  }, [pollInterval, refreshFeed]);

  // Guard against double-firing (e.g. swipe gesture + button tap) acting
  // on the same card twice.
  const actedOn = useRef(new Set<string>());

  const discard = useCallback((item: FeedItem) => {
    if (actedOn.current.has(item.id)) return;
    actedOn.current.add(item.id);
    setDiscarded((prev) => ({
      ...prev,
      [item.id]: { discardedAt: new Date().toISOString() },
    }));
  }, []);

  const saveItem = useCallback((item: FeedItem) => {
    if (actedOn.current.has(item.id)) return;
    actedOn.current.add(item.id);
    setSaved((prev) => ({
      ...prev,
      [item.id]: { item, savedAt: new Date().toISOString() },
    }));
  }, []);

  const unsave = useCallback((id: string) => {
    actedOn.current.delete(id);
    setSaved((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const togglePinned = useCallback(
    (id: string) => {
      const current =
        pinOverrides[id] ?? items.find((i) => i.id === id)?.pinned ?? false;
      setPinOverrides((prev) => ({ ...prev, [id]: !current }));
    },
    [pinOverrides, items],
  );

  const queue = sortQueue(
    items
      .filter((item) => !discarded[item.id] && !saved[item.id])
      .map((item) =>
        pinOverrides[item.id] !== undefined
          ? { ...item, pinned: pinOverrides[item.id] }
          : item,
      ),
  );

  return {
    queue,
    saved,
    loading,
    error,
    refreshFeed,
    discard,
    saveItem,
    unsave,
    togglePinned,
  };
}
