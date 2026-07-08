"use client";

import { useState } from "react";

/**
 * A list that renders the first `limit` items with a quiet "Show all n" /
 * "Show fewer" toggle. `render` must return a keyed <li>.
 */
export function ShowAllList<T>({
  items,
  limit = 10,
  render,
}: {
  items: T[];
  limit?: number;
  render: (item: T) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, limit);
  return (
    <div>
      <ul className="space-y-1.5">{visible.map(render)}</ul>
      {items.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 text-xs text-muted transition-colors hover:text-foreground"
        >
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
