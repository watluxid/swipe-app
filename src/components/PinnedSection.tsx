import type { Feed } from "../hooks/useFeed";

/**
 * Always-on strip above the card stack. Pinned items never enter the swipe
 * queue and can't be discarded — the only actions are opening the link and
 * toggling saved.
 */
export function PinnedSection({ feed }: { feed: Feed }) {
  if (feed.pinned.length === 0) return null;

  return (
    <section className="pinned-section" aria-label="Pinned items">
      <h2 className="pinned-heading">📌 Pinned</h2>
      <div className="pinned-strip">
        {feed.pinned.map((item) => {
          const isSaved = Boolean(feed.saved[item.id]);
          return (
            <article className="pinned-card" key={item.id}>
              <a
                className="pinned-link"
                href={item.url}
                target="_blank"
                rel="noreferrer"
              >
                <h3 className="pinned-title">{item.title}</h3>
                <p className="pinned-subtitle">{item.subtitle}</p>
              </a>
              <button
                className={`pinned-save ${isSaved ? "is-saved" : ""}`}
                aria-label={
                  isSaved ? `Unsave ${item.title}` : `Save ${item.title}`
                }
                aria-pressed={isSaved}
                onClick={() =>
                  isSaved ? feed.unsave(item.id) : feed.saveItem(item)
                }
              >
                ♥
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
