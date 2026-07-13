import type { FeedItem } from "../types";
import fixture from "./fixtures/feed.json";

/**
 * The contract every data source must satisfy. The UI and stores only ever
 * see FeedItem[] — where items come from is entirely the source's problem.
 * Dropping in a real remote source means writing one object with this shape
 * and pointing `activeSource` at it; nothing above this file changes.
 */
export interface FeedSource {
  getFeedItems(): Promise<FeedItem[]>;
}

/**
 * Fixture-backed source for local development and demos. Simulates a little
 * network latency so loading states are exercised the same way a real
 * source would exercise them.
 */
export const fixtureSource: FeedSource = {
  async getFeedItems() {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return dedupeById(fixture as FeedItem[]);
  },
};

/*
 * Example of what a remote source would look like — same interface, no UI
 * changes required:
 *
 *   export const remoteSource: FeedSource = {
 *     async getFeedItems() {
 *       const res = await fetch(FEED_URL);
 *       if (!res.ok) throw new Error(`Feed request failed: ${res.status}`);
 *       return dedupeById(await res.json());
 *     },
 *   };
 */

const activeSource: FeedSource = fixtureSource;

/** The single entry point the rest of the app calls. */
export function getFeedItems(): Promise<FeedItem[]> {
  return activeSource.getFeedItems();
}

/**
 * Sources can legitimately return duplicates (overlapping pages, a refresh
 * re-returning known items); last occurrence of an id wins so a re-fetched
 * item can carry updated fields.
 */
export function dedupeById(items: FeedItem[]): FeedItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
