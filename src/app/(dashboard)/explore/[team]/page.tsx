import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTeamScope } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import { safeDecodeURIComponent } from "@/lib/utils";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function TeamPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: Promise<{ period?: string; dim?: string; vendor?: string }> }) {
  const { team } = await params;
  const sp = await searchParams;
  const teamName = safeDecodeURIComponent(team);
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const scope = await getTeamScope(getSupabaseAdminClient(), teamName);
  return (
    <>
      <PageHeader title={teamName} subtitle="Team spend — drill into a person." />
      <ExploreView scope={scope} initialPeriodParam={sp.period} initialDim={dim} initialVendorParam={sp.vendor} />
    </>
  );
}
