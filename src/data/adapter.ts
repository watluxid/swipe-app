import type { FeedItem } from "../types";
import fixture from "./fixtures/feed.json";

/**
 * The single data-source adapter. Everything above this function is
 * source-agnostic: swapping the fixture for a remote API means changing
 * only this file (e.g. `const res = await fetch(FEED_URL); return res.json()`),
 * as long as the response maps into FeedItem[].
 *
 * The fixture path simulates a little network latency so loading states
 * are exercised the same way a real source would exercise them.
 */
export async function getFeedItems(): Promise<FeedItem[]> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return fixture as FeedItem[];
}
