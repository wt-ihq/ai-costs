import { requireDashboardAccess } from "@/lib/auth-guard";
import { getPersonCursorUsageCached, getPersonScopeCached } from "@/lib/queries/cached";
import { ExploreView } from "@/components/explore/explore-view";
import { PersonUsagePanel } from "@/components/cursor-usage/person-usage-panel";
import { PageHeader } from "@/components/ui";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params, searchParams }: { params: Promise<{ team: string; person: string }>; searchParams: Promise<{ period?: string; dim?: string; vendor?: string }> }) {
  const role = await requireDashboardAccess();
  const { person } = await params;
  const sp = await searchParams;
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const scope = await getPersonScopeCached(person);
  const usage = role === "admin" ? await getPersonCursorUsageCached(person) : null;
  return (
    <>
      <PageHeader title={scope.title} subtitle="Individual spend — where it occurs and when." />
      <ExploreView scope={scope} initialPeriodParam={sp.period} initialDim={dim} initialVendorParam={sp.vendor} />
      {usage && usage.months.length > 0 && <PersonUsagePanel scope={usage} />}
    </>
  );
}
