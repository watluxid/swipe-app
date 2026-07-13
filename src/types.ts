/**
 * The fixed schema every data source must map into. The UI and stores only
 * ever see this shape — where items come from is the adapter's problem.
 */
export interface FeedItem {
  id: string;
  title: string;
  subtitle: string;
  summary: string;
  url: string;
  tags: string[];
  /** ISO 8601 timestamp */
  date: string;
  /**
   * On feed items: floats the card to the front of the swipe queue.
   * Items from the separate pinned list (getPinnedItems) always carry
   * true and never enter the queue at all — they can't be discarded.
   */
  pinned: boolean;
}

/** Items swiped left. Keyed by id so re-fetched items stay hidden. */
export type DiscardedStore = Record<string, { discardedAt: string }>;

/**
 * Items swiped right. Stores a full snapshot of the item, not just the id,
 * so the Saved list keeps working even if the source stops returning it.
 */
export type SavedStore = Record<string, { item: FeedItem; savedAt: string }>;
