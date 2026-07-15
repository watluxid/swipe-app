import { useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { FeedItem } from "../types";

interface SwipeCardProps {
  item: FeedItem;
  /** Only the top card of the stack is interactive. */
  interactive: boolean;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
}

const SWIPE_THRESHOLD = 90; // px of horizontal drag to commit a swipe

export function SwipeCard({
  item,
  interactive,
  onSwipeLeft,
  onSwipeRight,
}: SwipeCardProps) {
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const start = useRef({ x: 0, y: 0 });

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!interactive || leaving) return;
    start.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragging || leaving) return;
    setDrag({
      x: e.clientX - start.current.x,
      y: (e.clientY - start.current.y) * 0.3,
    });
  }

  function onPointerUp() {
    if (!dragging || leaving) return;
    setDragging(false);
    if (drag.x <= -SWIPE_THRESHOLD) commit("left");
    else if (drag.x >= SWIPE_THRESHOLD) commit("right");
    else setDrag({ x: 0, y: 0 });
  }

  function commit(direction: "left" | "right") {
    setLeaving(direction);
    // Let the fly-out transition play before the card unmounts.
    setTimeout(direction === "left" ? onSwipeLeft : onSwipeRight, 250);
  }

  const x = leaving ? (leaving === "left" ? -600 : 600) : drag.x;
  const rotation = x / 18;
  const verdict =
    drag.x <= -SWIPE_THRESHOLD || leaving === "left"
      ? "discard"
      : drag.x >= SWIPE_THRESHOLD || leaving === "right"
        ? "save"
        : null;

  return (
    <div
      className={`card ${dragging ? "dragging" : ""}`}
      style={{
        transform: `translate(${x}px, ${drag.y}px) rotate(${rotation}deg)`,
        transition: dragging ? "none" : "transform 0.25s ease",
        touchAction: interactive ? "none" : "auto",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {verdict && (
        <div className={`verdict verdict-${verdict}`}>
          {verdict === "save" ? "SAVE" : "DISCARD"}
        </div>
      )}
      {item.pinned && <div className="pin-badge">📌 Pinned</div>}
      <h2 className="card-title">{item.title}</h2>
      <p className="card-subtitle">{item.subtitle}</p>
      <p className="card-summary">{item.summary}</p>
      <div className="card-meta">
        <div className="card-tags">
          {item.tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
        <time className="card-date">
          {new Date(item.date).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </time>
      </div>
      {interactive && (
        <div className="card-actions">
          <button
            className="action-btn discard-btn"
            aria-label="Discard"
            onClick={() => commit("left")}
          >
            ✕
          </button>
          <a
            className="action-btn open-btn"
            aria-label="Open article"
            href={item.url}
            target="_blank"
            rel="noreferrer"
            onPointerDown={(e) => e.stopPropagation()}
          >
            ↗
          </a>
          <button
            className="action-btn save-btn"
            aria-label="Save"
            onClick={() => commit("right")}
          >
            ♥
          </button>
        </div>
      )}
    </div>
  );
}
