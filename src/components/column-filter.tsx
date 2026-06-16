"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface FilterOption {
  value: string;
  label: string;
  color?: string;
}

const PANEL_W = 208; // w-52

/**
 * A column-header multi-select filter: a quiet funnel affordance that opens a
 * checklist popover. The panel renders in a portal with fixed positioning so it
 * escapes the table's overflow container. Active (not-all-selected) state shows
 * the accent colour + a count badge. Closes on click-outside / Escape / scroll.
 */
export function ColumnFilter({
  label,
  options,
  selected,
  onChange,
  align = "left",
}: {
  label: string;
  options: FilterOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  align?: "left" | "right";
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const open = pos !== null;
  const active = selected.size !== options.length;

  const openPanel = () => {
    const r = triggerRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 8, left: align === "right" ? r.right - PANEL_W : r.left });
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setPos(null) : openPanel())}
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          "group -mx-1 inline-flex items-center gap-1.5 rounded px-1 py-0.5 uppercase tracking-wide transition-colors hover:text-foreground",
          active && "text-accent",
        )}
      >
        <span>{label}</span>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className={cn("size-3 transition-colors", active ? "text-accent" : "text-muted/50 group-hover:text-muted")}>
          <path d="M2.5 4h11L9.5 9v3.5L6.5 14V9L2.5 4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        {active && <span className="rounded-full bg-accent/20 px-1.5 text-[10px] leading-tight text-accent tabular-nums">{selected.size}</span>}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="animate-popover fixed z-50 w-52 rounded-lg border border-border bg-surface p-1.5 shadow-2xl shadow-black/60"
            style={{ top: pos.top, left: pos.left, transformOrigin: align === "right" ? "top right" : "top left" }}
          >
            <div className="flex items-center justify-between px-2 py-1 text-[11px] uppercase tracking-wide text-muted">
              <span>{label}</span>
              <div className="flex gap-2 normal-case">
                <button type="button" onClick={() => onChange(new Set(options.map((o) => o.value)))} className="hover:text-foreground">All</button>
                <span className="text-border">·</span>
                <button type="button" onClick={() => onChange(new Set())} className="hover:text-foreground">Clear</button>
              </div>
            </div>
            <ul className="mt-0.5 max-h-64 overflow-auto">
              {options.map((o) => (
                <li key={o.value}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm normal-case tracking-normal text-foreground transition-colors hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={selected.has(o.value)}
                      onChange={() => toggle(o.value)}
                      className="size-3.5 cursor-pointer"
                      style={{ accentColor: "var(--accent)" }}
                    />
                    {o.color && <span className="size-2.5 rounded-full" style={{ background: o.color }} />}
                    <span className="flex-1">{o.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
