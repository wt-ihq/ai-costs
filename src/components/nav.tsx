"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const PAGES = [
  { href: "/explore", label: "Explore" },
  { href: "/cursor-models", label: "Cursor Usage", enterprise: true },
  { href: "/api-platforms", label: "API Platforms" },
  { href: "/data-health", label: "Data Health" },
  { href: "/imports", label: "Imports", admin: true },
];

export function Nav({ isAdmin = false, cursorAnalyticsEnabled = false }: { isAdmin?: boolean; cursorAnalyticsEnabled?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {PAGES.filter((p) => !p.admin || isAdmin).map((p) => {
        const active = p.href === "/explore" ? pathname.startsWith("/explore") : pathname === p.href;
        // Enterprise-gated pages render greyed with a badge until the plan is enabled.
        const locked = p.enterprise && !cursorAnalyticsEnabled;
        return (
          <Link
            key={p.href}
            href={p.href}
            className={cn(
              "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-surface-2 text-foreground"
                : "text-muted hover:bg-surface-2/60 hover:text-foreground",
              locked && "opacity-50",
            )}
          >
            {p.label}
            {p.admin && (
              <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                admin
              </span>
            )}
            {locked && (
              <span className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                Enterprise
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
