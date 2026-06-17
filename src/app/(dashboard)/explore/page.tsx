import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCompanyExplore } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import { parsePeriod } from "@/lib/explore/period";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ searchParams }: { searchParams: Promise<{ period?: string; dim?: string }> }) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period, new Date());
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const data = await getCompanyExplore(getSupabaseAdminClient(), period);
  return (
    <>
      <PageHeader title="Company" subtitle="AI spend across Intent HQ — drill into a team." />
      <ExploreView data={data} initialDim={dim} />
    </>
  );
}
