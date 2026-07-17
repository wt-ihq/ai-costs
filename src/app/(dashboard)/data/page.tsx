import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getRole } from "@/lib/auth-guard";
import { cn } from "@/lib/utils";
import { HealthTab } from "./health-tab";
import { ImportsTab } from "./imports-tab";
import { ToolsTab } from "./tools-tab";
import { SyncTab } from "./sync-tab";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "health", label: "Health", admin: false, subtitle: "Identity spine, per-source freshness, and the unmatched-identity queue." },
  { key: "imports", label: "Imports", admin: true, subtitle: "The monthly manual-import workflow: coverage and per-vendor import cards." },
  { key: "tools", label: "Tools & projects", admin: true, subtitle: "Recurring tool costs and Vercel project → department mapping." },
  { key: "sync", label: "Sync", admin: true, subtitle: "Manual sync trigger and backfill controls." },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/**
 * One "Data" page: health for everyone, the admin workflows behind tabs.
 * Tabs are links (?tab=…) so each renders server-side and fetches only its
 * own data — the old single Imports page fetched every section at once.
 */
export default async function DataPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const isAdmin = (await getRole()) === "admin";
  const requested = (await searchParams).tab as TabKey | undefined;
  const visible = TABS.filter((t) => !t.admin || isAdmin);
  // Non-admins asking for an admin tab just get Health — the nav never links
  // there for them, and the tab's actions are requireAdmin-gated regardless.
  const active = visible.find((t) => t.key === requested) ?? TABS[0];

  return (
    <>
      <PageHeader title="Data" subtitle={active.subtitle} />
      {visible.length > 1 && (
        <div className="mb-6 inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
          {visible.map((t) => (
            <Link
              key={t.key}
              href={t.key === "health" ? "/data" : `/data?tab=${t.key}`}
              className={cn(
                "rounded px-3 py-1.5 transition-colors",
                active.key === t.key ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
      )}
      {active.key === "health" && <HealthTab />}
      {active.key === "imports" && <ImportsTab />}
      {active.key === "tools" && <ToolsTab />}
      {active.key === "sync" && <SyncTab />}
    </>
  );
}
