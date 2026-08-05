import { getOpenRouterScopeCached } from "@/lib/queries/cached";
import { OpenRouterView } from "@/components/openrouter/openrouter-view";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OpenRouterPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const scope = await getOpenRouterScopeCached();
  return (
    <>
      <PageHeader title="OpenRouter analytics" subtitle="OpenRouter spend, tokens, and requests by model and person." />
      <OpenRouterView scope={scope} initialPeriodParam={sp.period} />
    </>
  );
}
