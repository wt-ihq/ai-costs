import { requireDashboardAccess } from "@/lib/auth-guard";
import { getApiPlatformsScopeCached } from "@/lib/queries/cached";
import { ApiPlatformsView } from "@/components/api-platforms/api-platforms-view";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ApiPlatformsPage({ searchParams }: { searchParams: Promise<{ period?: string; vendor?: string }> }) {
  await requireDashboardAccess();
  const sp = await searchParams;
  const scope = await getApiPlatformsScopeCached();

  return (
    <>
      <PageHeader
        title="API Platforms"
        subtitle="Direct-platform metered spend by vendor, key/project, and person, with model breakdown. OpenRouter has its own page."
      />
      <ApiPlatformsView scope={scope} initialPeriodParam={sp.period} initialVendorParam={sp.vendor} />
    </>
  );
}
