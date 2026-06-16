import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTeamExplore } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function TeamPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: Promise<{ month?: string; dim?: string }> }) {
  const { team } = await params;
  const sp = await searchParams;
  const teamName = decodeURIComponent(team);
  const month = sp.month ?? new Date().toISOString().slice(0, 7);
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const data = await getTeamExplore(getSupabaseAdminClient(), teamName, month);
  return (
    <>
      <PageHeader title={teamName} subtitle="Team spend — drill into a person." />
      <ExploreView data={data} initialDim={dim} />
    </>
  );
}
