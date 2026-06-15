import { Nav } from "@/components/nav";
import { auth } from "@/auth";

/** Best-effort session read — tolerates missing auth env in local dev. */
async function getRole(): Promise<string | undefined> {
  if (process.env.AUTH_DISABLED === "true") return "admin"; // local-dev bypass
  try {
    const session = await auth();
    return (session?.user as { role?: string } | undefined)?.role;
  } catch {
    return undefined;
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const role = await getRole();
  const isAdmin = role === "admin";

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col gap-6 border-r border-border bg-surface px-4 py-6">
        <div className="px-3">
          <div className="text-sm font-semibold tracking-tight">AI Spend</div>
          <div className="text-xs text-muted">Intent HQ</div>
        </div>
        <Nav isAdmin={isAdmin} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Global controls (spec §7): date range + department filter. */}
        <div className="flex items-center gap-3 border-b border-border px-8 py-3 text-sm text-muted">
          <span className="rounded-md border border-border px-3 py-1.5">
            Last 30 days
          </span>
          <span className="rounded-md border border-border px-3 py-1.5">
            All departments
          </span>
          <span className="ml-auto text-xs">
            {role ? `Signed in · ${role}` : "Not signed in"}
          </span>
        </div>
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
