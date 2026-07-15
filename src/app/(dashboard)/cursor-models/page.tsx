import { getModelUsageScopeCached, getCursorTopModelScopeCached, getCursorSpendScopeCached } from "@/lib/queries/cached";
import { CursorModelsView } from "@/components/cursor-models/cursor-models-view";
import { TeamsModelView } from "@/components/cursor-models/teams-model-view";
import { EnterpriseLocked } from "@/components/cursor-models/enterprise-locked";
import { CURSOR_ANALYTICS_ENABLED } from "@/lib/cursor-models/config";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CursorModelsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const header = (
    <PageHeader title="Cursor usage" subtitle="Cursor model adoption and spend by model, team, and person." />
  );

  // Enterprise: full per-model message volume from the Analytics API.
  if (CURSOR_ANALYTICS_ENABLED) {
    const scope = await getModelUsageScopeCached();
    return (
      <>
        {header}
        <CursorModelsView scope={scope} initialPeriodParam={sp.period} />
      </>
    );
  }

  // Teams plan: fall back to the per-user most-used-model signal if we have it;
  // otherwise show the Enterprise-only state.
  const [topModel, spend] = await Promise.all([
    getCursorTopModelScopeCached(),
    getCursorSpendScopeCached(),
  ]);
  return (
    <>
      {header}
      {topModel.rows.length > 0 ? (
        <TeamsModelView scope={topModel} spend={spend} initialPeriodParam={sp.period} />
      ) : (
        <EnterpriseLocked />
      )}
    </>
  );
}
