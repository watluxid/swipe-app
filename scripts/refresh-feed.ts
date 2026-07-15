/**
 * Regenerates src/data/fixtures/feed.json from PubMed. Run via
 * `npm run refresh-feed`, or on a schedule by
 * .github/workflows/refresh-feed.yml, which commits the result so the next
 * Pages deploy picks it up.
 *
 * Uses the default extractive summarizer (see src/data/sources/pubmed.ts) —
 * no model inference, no API key required.
 *
 * Dedupes against PMIDs already present in feed.json before fetching, so a
 * re-run only hits PubMed for genuinely new studies published since the last
 * run — not the whole 30-day window every time.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeById } from "../src/data/adapter";
import { fetchNephrologyFeed } from "../src/data/sources/pubmed";
import type { FeedItem } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEED_PATH = resolve(__dirname, "../src/data/fixtures/feed.json");

/** Bounds file size / git diff noise as the feed accumulates across runs. */
const MAX_FEED_SIZE = 300;

function loadExistingPubmedItems(): FeedItem[] {
  if (!existsSync(FEED_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(FEED_PATH, "utf8")) as FeedItem[];
    // Only PubMed-sourced items carry the pmid- prefix. Anything else is
    // leftover demo/fixture content — this job replaces it, it doesn't
    // preserve it indefinitely.
    return raw.filter((item) => item.id.startsWith("pmid-"));
  } catch {
    return [];
  }
}

async function main() {
  const existing = loadExistingPubmedItems();
  const seenIds = new Set(existing.map((item) => item.id));

  console.log(`Existing PubMed items in feed.json: ${existing.length}`);
  console.log(
    "Searching PubMed for new nephrology studies (extractive summaries, no AI calls)...",
  );

  const fresh = await fetchNephrologyFeed({ seenIds });
  console.log(`New studies found: ${fresh.length}`);

  const merged = dedupeById([...fresh, ...existing])
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, MAX_FEED_SIZE);

  writeFileSync(FEED_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Wrote ${merged.length} items to ${FEED_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
