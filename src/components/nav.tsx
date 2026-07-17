"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const PAGES: { href: string; label: string; admin?: boolean }[] = [
  { href: "/explore", label: "Explore" },
  { href: "/cursor", label: "Cursor Usage & Spend" },
  { href: "/api-platforms", label: "API Platforms" },
  { href: "/data", label: "Data" },
];

export function Nav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {PAGES.filter((p) => !p.admin || isAdmin).map((p) => {
        const active = p.href === "/explore" ? pathname.startsWith("/explore") : pathname === p.href;
        return (
          <Link
            key={p.href}
            href={p.href}
            className={cn(
              "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-surface-2 text-foreground"
                : "text-muted hover:bg-surface-2/60 hover:text-foreground",
            )}
          >
            {p.label}
            {p.admin && (
              <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                admin
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
