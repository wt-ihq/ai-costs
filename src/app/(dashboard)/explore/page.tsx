import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCompanyScope } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ searchParams }: { searchParams: Promise<{ period?: string; dim?: string; vendor?: string }> }) {
  const sp = await searchParams;
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const scope = await getCompanyScope(getSupabaseAdminClient());
  return (
    <>
      <PageHeader title="Company" subtitle="AI spend across Intent HQ — drill into a team or person." />
      <ExploreView scope={scope} initialPeriodParam={sp.period} initialDim={dim} initialVendorParam={sp.vendor} />
    </>
  );
}
