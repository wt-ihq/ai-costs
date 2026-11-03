import { requireDashboardAccess } from "@/lib/auth-guard";
import { getRecommendationsCached } from "@/lib/queries/cached";
import { withoutCursorActivity } from "@/lib/recommendations/load";
import { RecommendationsView } from "@/components/recommendations/recommendations-view";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RecommendationsPage() {
  const role = await requireDashboardAccess();
  const cached = await getRecommendationsCached();
  // Cursor activity (requests, active days) is admin-only — spec "Who may see Cursor activity". Stripped
  // here, on the server, so a viewer's page payload never carries it; the week bars then show spend only.
  const data = role === "admin" ? cached : withoutCursorActivity(cached);
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
