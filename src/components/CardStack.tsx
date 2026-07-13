import type { Feed } from "../hooks/useFeed";
import { SwipeCard } from "./SwipeCard";

const VISIBLE_CARDS = 3;

export function CardStack({ feed }: { feed: Feed }) {
  const { queue, loading, error, refreshFeed, discard, saveItem } = feed;

  if (error) {
    return (
      <div className="feed-empty">
        <p>Couldn’t load the feed.</p>
        <p className="feed-empty-detail">{error}</p>
        <button className="refresh-btn" onClick={() => void refreshFeed()}>
          Try again
        </button>
      </div>
    );
  }

  if (loading && queue.length === 0) {
    return <div className="feed-empty">Loading…</div>;
  }

  if (queue.length === 0) {
    return (
      <div className="feed-empty">
        <p>You’re all caught up 🎉</p>
        <button className="refresh-btn" onClick={() => void refreshFeed()}>
          Refresh feed
        </button>
      </div>
    );
  }

  const visible = queue.slice(0, VISIBLE_CARDS);

  return (
    <div className="stack">
      {visible
        .map((item, index) => (
          <div
            className="stack-slot"
            key={item.id}
            style={{
              zIndex: VISIBLE_CARDS - index,
              transform: `translateY(${index * 10}px) scale(${1 - index * 0.04})`,
            }}
          >
            <SwipeCard
              item={item}
              interactive={index === 0}
              onSwipeLeft={() => discard(item)}
              onSwipeRight={() => saveItem(item)}
            />
          </div>
        ))
        // Render back-to-front so the top card wins pointer events last.
        .reverse()}
    </div>
  );
}
