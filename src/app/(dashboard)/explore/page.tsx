import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCompanyExplore } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ searchParams }: { searchParams: Promise<{ month?: string; dim?: string }> }) {
  const sp = await searchParams;
  const month = sp.month ?? new Date().toISOString().slice(0, 7);
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const data = await getCompanyExplore(getSupabaseAdminClient(), month);
  return (
    <>
      <PageHeader title="Company" subtitle="AI spend across Intent HQ — drill into a team." />
      <ExploreView data={data} initialDim={dim} />
    </>
  );
}
