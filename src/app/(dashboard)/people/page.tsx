import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getPeopleData } from "@/lib/queries/people";
import { PageHeader } from "@/components/ui";
import { PeopleTable } from "@/components/people-table";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const { month, rows } = await getPeopleData(getSupabaseAdminClient(), new Date());

  return (
    <>
      <PageHeader
        title="People"
        subtitle={`Per-person seat, overage and metered spend for ${month}. Filter to idle seats for the hygiene view.`}
      />
      <PeopleTable rows={rows} />
    </>
  );
}
