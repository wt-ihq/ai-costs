"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export function Breadcrumb() {
  const parts = usePathname().split("/").filter(Boolean); // ["explore", team?, person?]
  const qs = useSearchParams().toString();
  const q = qs ? `?${qs}` : "";
  const crumbs = [{ href: `/explore${q}`, label: "Company" }];
  if (parts[1]) crumbs.push({ href: `/explore/${parts[1]}${q}`, label: decodeURIComponent(parts[1]) });
  if (parts[2]) crumbs.push({ href: `/explore/${parts[1]}/${parts[2]}${q}`, label: "Individual" });
  return (
    <nav className="flex items-center gap-2 text-sm text-muted">
      {crumbs.map((c, i) => (
        <span key={c.href} className="flex items-center gap-2">
          {i > 0 && <span className="text-border">/</span>}
          {i < crumbs.length - 1 ? <Link href={c.href} className="hover:text-foreground">{c.label}</Link> : <span className="text-foreground">{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}
