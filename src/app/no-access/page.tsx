import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDashboardAccess } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

/**
 * Where requireDashboardAccess sends people who can sign in but aren't on the
 * access list. Outside the dashboard layout, so it loads no spend data.
 */
export default async function NoAccessPage() {
  const access = await getDashboardAccess();
  if (!access) redirect("/api/auth/signin");
  if (access.allowed) redirect("/explore");

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md text-center">
        <Image src="/intenthq-logo.png" alt="Intent HQ" width={2248} height={544} priority className="mx-auto mb-6 h-auto w-36" />
        <h1 className="mb-2 text-lg font-semibold">You don&apos;t have access to the AI costs dashboard — ask Workplace Tech</h1>
        {access.email && <p className="mb-6 text-sm text-muted">Signed in as {access.email}</p>}
        {/* Auth.js's own sign-out page (it asks to confirm): no server action needed. */}
        <Link href="/api/auth/signout" prefetch={false} className="text-sm text-accent hover:underline">Sign out</Link>
      </div>
    </main>
  );
}
