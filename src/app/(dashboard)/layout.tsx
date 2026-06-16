import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { auth } from "@/auth";

/**
 * Authoritative auth gate for the whole dashboard (every page nests here).
 * Verifies the real session server-side and redirects signed-out users.
 * AUTH_DISABLED is a local-dev-only bypass (never set in production).
 */
async function requireRole(): Promise<string> {
  if (process.env.AUTH_DISABLED === "true") return "admin";
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/api/auth/signin");
  return (session.user as { role?: string }).role ?? "viewer";
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const role = await requireRole();
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
        {/* Slim status bar — date range / department filtering live in the
            Explore views (period dropdown + drill-down), not here. */}
        <div className="flex items-center justify-end border-b border-border px-8 py-3 text-xs text-muted">
          <span>{role ? `Signed in · ${role}` : "Not signed in"}</span>
        </div>
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
