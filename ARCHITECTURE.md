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
| `pinOverrides` | `Record<id, boolean>` | Local user overrides of the source-provided `pinned` flag |

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
  getFeedItems(): Promise<FeedItem[]>;
}
```

The rest of the app calls the module-level `getFeedItems()`, which delegates
to `activeSource`. Today that's `fixtureSource`, resolving a local JSON
fixture (`src/data/fixtures/feed.json`, 15 demo items) with simulated
latency. Dropping in a real remote source means writing one `FeedSource`
object and repointing `activeSource` — the file contains a commented example.
Sources dedupe their own output by `id` via the shared `dedupeById` helper
(last occurrence wins, so a re-fetched item can carry updated fields).

## Refresh strategy

`useFeed()` (`src/hooks/useFeed.ts`) owns all feed state and exposes
`refreshFeed()`, which:

1. calls `getFeedItems()`,
2. dedupes by `id` against what's in memory (a refresh may return known items),
3. filters out discarded ("seen") and saved items by `id`,
4. sorts pinned-first, then newest-first by `date`.

Refresh is triggered on mount, manually (header ⟳ button, empty-state and
error-state buttons), and optionally on a schedule: `useFeed({ pollInterval })`
starts an interval that re-runs `refreshFeed()` — off by default since the
fixture is static, but ready for a remote source
(`useFeed({ pollInterval: 5 * 60_000 })` in `App.tsx`).

Errors from the adapter land in `feed.error` and render a retry state instead
of crashing the stack.

## UI

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
