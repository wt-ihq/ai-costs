import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getPersonExplore } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import { parsePeriod } from "@/lib/explore/period";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params, searchParams }: { params: Promise<{ team: string; person: string }>; searchParams: Promise<{ period?: string; dim?: string }> }) {
  const { team, person } = await params;
  const sp = await searchParams;
  const period = parsePeriod(sp.period, new Date());
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const data = await getPersonExplore(getSupabaseAdminClient(), decodeURIComponent(team), person, period);
  return (
    <>
      <PageHeader title={data.title} subtitle="Individual spend — where it occurs and when." />
      <ExploreView data={data} initialDim={dim} />
    </>
  );
}
