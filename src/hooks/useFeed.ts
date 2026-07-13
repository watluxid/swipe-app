import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscardedStore, FeedItem, SavedStore } from "../types";
import {
  dedupeById,
  getFeedItems,
  getPinnedItems,
} from "../data/adapter";
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
  /** Undiscarded, unsaved, unpinned items: newest first. */
  queue: FeedItem[];
  /** Always-visible pinned items — never enter the queue, can't be discarded. */
  pinned: FeedItem[];
  saved: SavedStore;
  loading: boolean;
  error: string | null;
  refreshFeed: () => Promise<void>;
  discard: (item: FeedItem) => void;
  saveItem: (item: FeedItem) => void;
  unsave: (id: string) => void;
}

function sortQueue(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    // A source can still flag individual feed items pinned to float them
    // to the front of the queue (distinct from the separate pinned list).
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return Date.parse(b.date) - Date.parse(a.date);
  });
}

export function useFeed({ pollInterval }: UseFeedOptions = {}): Feed {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [pinned, setPinned] = useState<FeedItem[]>([]);
  const [discarded, setDiscarded] = useState<DiscardedStore>(() =>
    load("discarded", {}),
  );
  const [saved, setSaved] = useState<SavedStore>(() => load("saved", {}));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => save("discarded", discarded), [discarded]);
  useEffect(() => save("saved", saved), [saved]);

  // Monotonic sequence so overlapping refreshes (slow network + manual
  // refresh + poll tick) can't apply out of order: only the newest wins.
  const refreshSeq = useRef(0);

  const refreshFeed = useCallback(async () => {
    const seq = ++refreshSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [feedItems, pinnedItems] = await Promise.all([
        getFeedItems(),
        getPinnedItems(),
      ]);
      if (seq !== refreshSeq.current) return; // superseded by a newer refresh
      setItems(dedupeById(feedItems));
      setPinned(dedupeById(pinnedItems));
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setError(e instanceof Error ? e.message : "Failed to load feed");
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
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

  const pinnedIds = new Set(pinned.map((item) => item.id));
  const pinnedIdsRef = useRef(pinnedIds);
  pinnedIdsRef.current = pinnedIds;

  // Guard against double-firing (e.g. swipe gesture + button tap) acting
  // on the same card twice.
  const actedOn = useRef(new Set<string>());

  const discard = useCallback((item: FeedItem) => {
    // Store-level guarantee, not just a UI convention: pinned items
    // can't be discarded.
    if (pinnedIdsRef.current.has(item.id)) return;
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

  const queue = sortQueue(
    items.filter(
      (item) =>
        !pinnedIds.has(item.id) && !discarded[item.id] && !saved[item.id],
    ),
  );

  return {
    queue,
    pinned,
    saved,
    loading,
    error,
    refreshFeed,
    discard,
    saveItem,
    unsave,
  };
}
