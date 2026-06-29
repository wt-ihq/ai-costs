import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getModelUsageScope } from "@/lib/queries/cursor-models";
import { CursorModelsView } from "@/components/cursor-models/cursor-models-view";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CursorModelsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const scope = await getModelUsageScope(getSupabaseAdminClient());
  return (
    <>
      <PageHeader title="Cursor usage" subtitle="Cursor model adoption — message volume by model, team, and person (not spend)." />
      <CursorModelsView scope={scope} initialPeriodParam={sp.period} />
    </>
  );
}
