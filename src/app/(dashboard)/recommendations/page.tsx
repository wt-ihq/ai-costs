import { requireDashboardAccess } from "@/lib/auth-guard";
import { getRecommendationsCached } from "@/lib/queries/cached";
import { RecommendationsView } from "@/components/recommendations/recommendations-view";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RecommendationsPage() {
  await requireDashboardAccess();
  const data = await getRecommendationsCached();
  return (
    <>
      <PageHeader
        title="Recommendations"
        subtitle="People on a Standard seat whose extra usage would have paid for Premium."
      />
      <RecommendationsView data={data} />
    </>
  );
}
