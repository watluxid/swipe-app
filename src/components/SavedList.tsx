import type { Feed } from "../hooks/useFeed";

export function SavedList({ feed }: { feed: Feed }) {
  const entries = Object.values(feed.saved).sort((a, b) =>
    b.savedAt.localeCompare(a.savedAt),
  );

  if (entries.length === 0) {
    return (
      <div className="feed-empty">
        <p>Nothing saved yet.</p>
        <p className="feed-empty-detail">Swipe right on a card to save it.</p>
      </div>
    );
  }

  return (
    <ul className="saved-list">
      {entries.map(({ item, savedAt }) => (
        <li className="saved-item" key={item.id}>
          <div className="saved-body">
            <a href={item.url} target="_blank" rel="noreferrer">
              <h3 className="saved-title">{item.title}</h3>
            </a>
            <p className="saved-subtitle">{item.subtitle}</p>
            <p className="saved-meta">
              Saved{" "}
              {new Date(savedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
              {" · "}
              {item.tags.join(", ")}
            </p>
          </div>
          <button
            className="unsave-btn"
            aria-label={`Remove ${item.title} from saved`}
            onClick={() => feed.unsave(item.id)}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}
