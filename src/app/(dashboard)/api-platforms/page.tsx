import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getApiPlatformsScope } from "@/lib/queries/api-platforms";
import { ApiPlatformsView } from "@/components/api-platforms/api-platforms-view";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ApiPlatformsPage({ searchParams }: { searchParams: Promise<{ period?: string; vendor?: string }> }) {
  const sp = await searchParams;
  const scope = await getApiPlatformsScope(getSupabaseAdminClient());

  return (
    <>
      <PageHeader
        title="API Platforms"
        subtitle="Metered spend by vendor, key/project, and person, with model breakdown."
      />
      <ApiPlatformsView scope={scope} initialPeriodParam={sp.period} initialVendorParam={sp.vendor} />
    </>
  );
}
