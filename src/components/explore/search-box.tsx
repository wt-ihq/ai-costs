"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SearchItem } from "@/lib/queries/explore";
import { cn } from "@/lib/utils";

const MAX_RESULTS = 8;

function rank(items: SearchItem[], q: string): SearchItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    const hay = item.label.toLowerCase();
    const idx = hay.indexOf(needle);
    if (idx === -1) continue;
    // Prefer prefix matches, then earlier matches, then shorter labels.
    scored.push({ item, score: idx === 0 ? 0 : idx + 1 });
  }
  scored.sort((a, b) => a.score - b.score || a.item.label.length - b.item.label.length);
  return scored.slice(0, MAX_RESULTS).map((s) => s.item);
}

/** Autocomplete that jumps to a team or person's explore page. */
export function SearchBox({ items }: { items: SearchItem[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => rank(items, query), [items, query]);

  // Reset highlight when the result set changes.
  useEffect(() => setActive(0), [query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const go = (item: SearchItem) => {
    setOpen(false);
    setQuery("");
    router.push(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showList = open && results.length > 0;

  return (
    <div ref={rootRef} className="relative w-full max-w-xs">
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search teams & people…"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent/60 focus:outline-none"
      />
      {showList && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface shadow-lg"
        >
          {results.map((item, i) => (
            <li key={`${item.kind}:${item.href}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); go(item); }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors",
                  i === active ? "bg-surface-2 text-foreground" : "text-foreground hover:bg-surface-2/60",
                )}
              >
                <span className="truncate">{item.label}</span>
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                    item.kind === "team" ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted",
                  )}
                >
                  {item.kind === "team" ? "Team" : item.sub}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
