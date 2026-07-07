"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Sparkles } from "lucide-react";
import { CHANGELOG, hasUnseen } from "@/lib/changelog";
import { cn } from "@/lib/utils";

const SEEN_KEY = "ai-costs:changelog-seen";

// Tiny external store over localStorage so React re-renders when the seen
// date changes. Same-tab writes don't fire "storage" events, hence the
// manual listener set; the "storage" listener picks up other tabs.
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

// localStorage can throw (private-mode Safari, storage disabled). Failure
// degrades to "always glowing" — never a crash.
function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(date: string) {
  try {
    window.localStorage.setItem(SEEN_KEY, date);
  } catch {
    // Ignore: the glow will just persist in this browser.
  }
  listeners.forEach((l) => l());
}

/** Status-bar "What's new" button; glows until the latest entry is seen. */
export function WhatsNew() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const latest = CHANGELOG[0]?.date;
  // The server snapshot pretends the latest entry is seen, so SSR and the
  // first client paint render glowless; the real localStorage value lights
  // it up right after hydration (no mismatch).
  const lastSeen = useSyncExternalStore(subscribe, readSeen, () => latest ?? null);
  const glow = latest ? hasUnseen(latest, lastSeen) : false;

  // Close on outside click (same convention as explore/search-box.tsx).
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = () => {
    if (!open && latest) writeSeen(latest);
    setOpen((o) => !o);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        aria-label="What's new"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-foreground",
          glow && "animate-glow text-accent",
        )}
      >
        <Sparkles className="h-4 w-4" aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Release notes"
          className="absolute right-0 z-50 mt-1 max-h-96 w-80 overflow-y-auto rounded-md border border-border bg-surface p-4 shadow-lg"
        >
          <div className="mb-3 text-sm font-semibold text-foreground">What&apos;s new</div>
          {CHANGELOG.length === 0 ? (
            <p className="text-sm text-muted">No release notes yet.</p>
          ) : (
            <ul className="space-y-4">
              {CHANGELOG.map((entry) => (
                <li key={entry.date}>
                  <div className="text-xs text-muted">{entry.date}</div>
                  <div className="text-sm font-medium text-foreground">{entry.title}</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-muted">
                    {entry.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
