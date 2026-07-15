import { getPersonScopeCached } from "@/lib/queries/cached";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params, searchParams }: { params: Promise<{ team: string; person: string }>; searchParams: Promise<{ period?: string; dim?: string; vendor?: string }> }) {
  const { person } = await params;
  const sp = await searchParams;
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const scope = await getPersonScopeCached(person);
  return (
    <>
      <PageHeader title={scope.title} subtitle="Individual spend — where it occurs and when." />
      <ExploreView scope={scope} initialPeriodParam={sp.period} initialDim={dim} initialVendorParam={sp.vendor} />
    </>
  );
}
