import { useState } from "react";
import { useFeed } from "./hooks/useFeed";
import { CardStack } from "./components/CardStack";
import { PinnedSection } from "./components/PinnedSection";
import { SavedList } from "./components/SavedList";

type View = "feed" | "saved";

export default function App() {
  // Pass { pollInterval: 5 * 60_000 } here once the adapter talks to a
  // remote source that produces new items over time.
  const feed = useFeed();
  const [view, setView] = useState<View>("feed");
  const savedCount = Object.keys(feed.saved).length;

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Swipe Reader</h1>
        <button
          className="refresh-icon"
          aria-label="Refresh feed"
          onClick={() => void feed.refreshFeed()}
        >
          ⟳
        </button>
      </header>

      <main className="app-main">
        {view === "feed" ? (
          <>
            <PinnedSection feed={feed} />
            <CardStack feed={feed} />
          </>
        ) : (
          <SavedList feed={feed} />
        )}
      </main>

      <nav className="app-nav">
        <button
          className={`nav-btn ${view === "feed" ? "active" : ""}`}
          onClick={() => setView("feed")}
        >
          Feed
          {feed.queue.length > 0 && (
            <span className="badge">{feed.queue.length}</span>
          )}
        </button>
        <button
          className={`nav-btn ${view === "saved" ? "active" : ""}`}
          onClick={() => setView("saved")}
        >
          Saved
          {savedCount > 0 && <span className="badge">{savedCount}</span>}
        </button>
      </nav>
    </div>
  );
}
