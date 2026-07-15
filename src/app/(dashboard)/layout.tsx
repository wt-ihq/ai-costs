import Image from "next/image";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { SearchBox } from "@/components/explore/search-box";
import { WhatsNew } from "@/components/whats-new";
import { getSearchIndexCached } from "@/lib/queries/cached";
import { requireRole } from "@/lib/auth-guard";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const role = await requireRole();
  const isAdmin = role === "admin";
  const searchIndex = await getSearchIndexCached();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col gap-6 border-r border-border bg-surface px-4 py-6">
        <div className="px-3">
          {/* Logo + app name link home (/ redirects to Explore). */}
          <Link href="/" className="block">
            <Image
              src="/intenthq-logo.png"
              alt="Intent HQ — Customer Intelligence Lab"
              width={2248}
              height={544}
              priority
              className="mb-3 h-auto w-36"
            />
            <div className="text-sm font-semibold tracking-tight">AI Spend &amp; Usage</div>
          </Link>
        </div>
        <Nav isAdmin={isAdmin} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Slim status bar — date range / department filtering live in the
            Explore views (period dropdown + drill-down), not here. */}
        <div className="flex items-center justify-between gap-4 border-b border-border px-8 py-3 text-xs text-muted">
          <SearchBox items={searchIndex} />
          <div className="flex items-center gap-3">
            <WhatsNew />
            <span>{role ? `Signed in · ${role}` : "Not signed in"}</span>
          </div>
        </div>
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
