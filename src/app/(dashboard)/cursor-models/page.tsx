import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getModelUsageScope } from "@/lib/queries/cursor-models";
import { CursorModelsView } from "@/components/cursor-models/cursor-models-view";
import { EnterpriseLocked } from "@/components/cursor-models/enterprise-locked";
import { CURSOR_ANALYTICS_ENABLED } from "@/lib/cursor-models/config";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CursorModelsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const header = (
    <PageHeader title="Cursor usage" subtitle="Cursor model adoption — message volume by model, team, and person (not spend)." />
  );

  // The Cursor Analytics API is Enterprise-only; skip the (empty) query and show
  // the locked state until the plan is enabled.
  if (!CURSOR_ANALYTICS_ENABLED) {
    return (
      <>
        {header}
        <EnterpriseLocked />
      </>
    );
  }

  const scope = await getModelUsageScope(getSupabaseAdminClient());
  return (
    <>
      {header}
      <CursorModelsView scope={scope} initialPeriodParam={sp.period} />
    </>
  );
}
