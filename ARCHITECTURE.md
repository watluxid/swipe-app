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

The persistence layer is behind `load`/`save` helpers so the backend can be
swapped (IndexedDB, remote sync) without touching the state hook.

## Source-agnostic data adapter

`src/data/adapter.ts` exposes exactly one function:

```ts
getFeedItems(): Promise<FeedItem[]>
```

Nothing above it knows where items come from. Today it resolves a local JSON
fixture (`src/data/fixtures/feed.json`) with simulated latency; swapping in a
remote API is a one-file change as long as the response maps into
`FeedItem[]`.

## Refresh strategy

`useFeed()` (`src/hooks/useFeed.ts`) owns all feed state and exposes
`refreshFeed()`, which:

1. calls `getFeedItems()`,
2. dedupes by `id` (a refresh may return items already in memory),
3. filters out discarded and saved items,
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
