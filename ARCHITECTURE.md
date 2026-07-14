# Swipe Reader — Architecture

A mobile-web card-feed reader. Swipe left to discard, swipe right to save;
saved items live in a separate Saved list view.

## Data model

The fixed item schema every source must map into (`src/types.ts`):

```ts
interface FeedItem {
  id: string;        // stable unique key — used for dedupe and store references
  title: string;
  subtitle: string;
  summary: string;
  url: string;
  tags: string[];
  date: string;      // ISO 8601
  pinned: boolean;   // pinned items sort to the top of the feed
}
```

### Stores

Both stores are keyed by item `id` and persisted to `localStorage`
(`src/store/persistence.ts`), so a refresh that re-returns an item never
resurfaces something the user already dealt with.

| Store | Shape | Purpose |
| --- | --- | --- |
| `discarded` | `Record<id, { discardedAt }>` | "Seen" items swiped left; filtered out of the feed queue |
| `saved` | `Record<id, { item, savedAt }>` | Full item **snapshots**, so the Saved list works even if the source stops returning an item |

### Pinned items

Pinned items come from a **separate static list** (`getPinnedItems()`, backed
by `src/data/fixtures/pinned.json`) using the same `FeedItem` schema. The
seed list is a starter set of landmark nephrology trials (RENAAL, IDNT,
SPRINT, CREDENCE, DAPA-CKD, EMPA-KIDNEY, FIDELIO-DKD, TEMPO 3:4, MENTOR),
spanning the subtopics the Renal Fellow Network "Landmark Nephrology" series
covers — replace or extend freely. They
render in an always-visible strip above the card stack, are excluded from the
swipe queue entirely, and **can't be discarded** — `discard()` refuses pinned
ids at the store level, so it's a guarantee rather than a UI convention. They
can still be saved (heart toggle on the strip). Independently, a source may
flag an ordinary feed item `pinned: true` to float it to the front of the
swipe queue; that's a sort hint, not the same thing as the pinned list.

The persistence layer is behind a pluggable `StorageBackend` interface
(`get`/`set` string pairs). The default backend is `localStorage`, chosen by a
feature probe at startup; if it's unavailable (private mode, sandboxed
embeds), an in-memory backend takes over automatically — the app keeps
working, state just doesn't survive a reload. An artifact-style host would
supply a `window.storage`-backed implementation here instead. `useFeed` only
ever sees the `load`/`save` helpers, so backends swap without touching it.

## Source-agnostic data adapter

`src/data/adapter.ts` defines the contract every data source must satisfy:

```ts
interface FeedSource {
  getFeedItems(): Promise<FeedItem[]>;   // the swipeable feed
  getPinnedItems(): Promise<FeedItem[]>; // the always-visible pinned list
}
```

The rest of the app calls the module-level `getFeedItems()`/`getPinnedItems()`,
which delegate to `activeSource`. Today that's `fixtureSource`, resolving
local JSON fixtures (`src/data/fixtures/feed.json`, 15 demo items, and
`pinned.json`, 3 placeholder pins) with simulated latency. Dropping in a real
remote source means writing one `FeedSource` object and repointing
`activeSource` — the file contains a commented example.
Sources dedupe their own output by `id` via the shared `dedupeById` helper
(last occurrence wins, so a re-fetched item can carry updated fields).

## PubMed source (server-side)

`src/data/sources/pubmed.ts` is a real `FeedSource` implementation that pulls
recent nephrology literature from the NCBI E-utilities API and returns it in
the same `FeedItem` schema — a drop-in for `activeSource`, no UI changes.

**Server-side only.** It uses secret keys (NCBI + Anthropic) and must never
ship to the browser; it is deliberately not imported by any client module, so
it stays out of the Vite bundle. Run it as a scheduled job that writes
`feed.json` (or a DB), or behind a `/api/feed` endpoint the client fetches.

Pipeline: `esearch` (nephrology MeSH major topics + palliative-care-in-kidney
terms, last 30 days by publication date) → **dedupe** the returned PMIDs
against the caller's "seen" set (`pmid-<PMID>`) *before* any summary work →
`esummary` (title, journal, date) + `efetch` (abstract, conclusion section,
MeSH tags) → Claude generates a 1–2 sentence plain-language paraphrase of each
conclusion (`claude-opus-4-8`, prompted to avoid verbatim abstract text and
templated openers) → `FeedItem[]`.

Configuration is all environment-driven (`NCBI_API_KEY`, `NCBI_TOOL`,
`NCBI_EMAIL`, `ANTHROPIC_API_KEY`). API scoping and rate-limiting:

- **Scoped:** `db=pubmed` only; `retmax` capped (default 40/run); every request
  carries `tool`/`email` per NCBI etiquette.
- **Rate-limited:** a single serialized queue spaces *all* NCBI calls by a
  minimum interval — ~9/s with an API key, ~2.8/s without — staying under
  NCBI's 10/s (keyed) and 3/s (unkeyed) ceilings. Claude summaries run under a
  fixed concurrency cap. Deduping before summarizing means a daily run only
  spends tokens on genuinely new papers.

`getFeedItems()` takes an optional seen set / window / cap
(`fetchNephrologyFeed({ seenIds, sinceDays, maxItems })`); `getPinnedItems()`
serves the static landmark-trial list from `pinned.json`.

> Note: this environment's egress policy blocks the NCBI and renalfellow.org
> hosts, so the job is typechecked and its client-bundle exclusion verified
> here, but it was not executed end-to-end against the live APIs — that runs in
> the deployment environment where those hosts are reachable.

## Refresh strategy

`useFeed()` (`src/hooks/useFeed.ts`) owns all feed state and exposes
`refreshFeed()`, which:

1. calls `getFeedItems()` and `getPinnedItems()` in parallel,
2. dedupes by `id` (a refresh may return known items),
3. filters the queue: no discarded ("seen"), saved, or pinned-list ids,
4. sorts pinned-flag-first, then newest-first by `date`.

Overlapping refreshes (slow network + manual refresh + poll tick) are
serialized by a monotonic sequence counter: only the newest request's
response is applied, so a stale slow response can never clobber fresh data.

Refresh is triggered on mount, manually (header ⟳ button, empty-state and
error-state buttons), and optionally on a schedule: `useFeed({ pollInterval })`
starts an interval that re-runs `refreshFeed()` — off by default since the
fixture is static, but ready for a remote source
(`useFeed({ pollInterval: 5 * 60_000 })` in `App.tsx`).

Errors from the adapter land in `feed.error` and render a retry state instead
of crashing the stack.

## UI

- `PinnedSection` renders the pinned list as a horizontally scrolling strip
  above the stack, with open-link and save-toggle actions only (no discard).
- `CardStack` renders the top 3 queue items as a stack; only the top card is
  interactive.
- `SwipeCard` implements the gesture with raw pointer events (no gesture
  library): drag past a 90 px threshold to commit, with a SAVE/DISCARD verdict
  label while dragging and explicit ✕ / ♥ buttons as a no-gesture fallback.
- `SavedList` shows saved snapshots newest-first with an unsave action
  (unsaving returns the item to the feed queue).

## Running

```sh
npm install
npm run dev      # dev server
npm run build    # typecheck + production build
```
