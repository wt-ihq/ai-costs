"use client";

import { useState } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { sidebarCookie } from "@/lib/sidebar";
import { cn } from "@/lib/utils";

/**
 * The left menu with a show/hide toggle on its right edge. Collapsed leaves a
 * slim rail so the toggle stays reachable. The rail is sticky so the toggle
 * (vertically centred) stays in view on long pages.
 */
export function SidebarShell({
  initialCollapsed,
  children,
}: {
  initialCollapsed: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = sidebarCookie(next);
  };

  const label = collapsed ? "Show menu" : "Hide menu";

  return (
    <div
      className={cn(
        "sticky top-0 z-10 h-screen shrink-0 self-start border-r border-border bg-surface",
        "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-3" : "w-60",
      )}
    >
      {/* Clip the fixed-width menu while the rail animates; the toggle sits outside the clip. */}
      <div className="h-full overflow-hidden">
        {/* inert: a hidden menu's links drop out of the tab order and the a11y tree. */}
        <aside
          inert={collapsed}
          className={cn(
            "flex h-full w-60 flex-col gap-6 overflow-y-auto px-4 py-6 transition-opacity duration-200 motion-reduce:transition-none",
            collapsed && "opacity-0",
          )}
        >
          {children}
        </aside>
      </div>
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={!collapsed}
        title={label}
        className="absolute top-1/2 -right-3 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <ChevronsLeftRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
