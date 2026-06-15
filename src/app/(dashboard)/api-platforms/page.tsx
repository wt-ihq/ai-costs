import { AwaitingData, PageHeader, Panel } from "@/components/ui";

export default function ApiPlatformsPage() {
  return (
    <>
      <PageHeader
        title="API Platforms"
        subtitle="Anthropic + OpenAI (+ Cursor overage) by key/project, with creator attribution."
      />
      <Panel>
        <AwaitingData note="Spend by key/project with creator attribution, model breakdown, per-row trend sparklines (spec §7.4)" />
      </Panel>
    </>
  );
}
