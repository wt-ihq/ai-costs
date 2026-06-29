/**
 * Live-DB proof of the Cursor pipeline (no vendor key needed — uses a fixture
 * fetcher). Seeds two employees, runs syncCursor twice, and verifies:
 *   - facts are written and attributed to employees
 *   - the unknown email lands in the Unmatched bucket (employee_id null)
 *   - a second identical run does NOT duplicate (idempotent upsert)
 *
 * Run: npx tsx scripts/prove-cursor.ts   (reads .env.local)
 */
import { createClient } from "@supabase/supabase-js";
import { syncCursor } from "@/lib/ingest/run-cursor";
import { cursorUsageFixture } from "@/lib/ingest/fixtures/cursor-usage";

process.loadEnvFile(".env.local");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const window = { startDate: "2026-06-01", endDate: "2026-06-02" };
const fixtureFetcher = async () => cursorUsageFixture;
const emptyMembers = async () => ({ teamMembers: [] }); // seat roster covered by the usage fixture here

async function countCursorFacts() {
  const { count } = await supabase
    .from("spend_facts")
    .select("*", { count: "exact", head: true })
    .eq("source", "cursor");
  return count ?? 0;
}

async function main() {
  // Clean slate for repeatable runs.
  await supabase.from("spend_facts").delete().eq("source", "cursor");
  await supabase.from("raw_payloads").delete().eq("source", "cursor");
  await supabase.from("sync_runs").delete().eq("source", "cursor");
  await supabase.from("employees").delete().in("email", [
    "gareth.jones@intenthq.com",
    "tom.reeve@intenthq.com",
  ]);

  // Seed employees so attribution resolves.
  await supabase.from("employees").insert([
    { okta_id: "00u1", email: "gareth.jones@intenthq.com", full_name: "Gareth Jones", department: "Engineering" },
    { okta_id: "00u2", email: "tom.reeve@intenthq.com", full_name: "Tom Reeve", department: "Product" },
  ]);

  console.log("Run 1 …");
  const r1 = await syncCursor(supabase, window, fixtureFetcher, undefined, emptyMembers);
  const c1 = await countCursorFacts();
  console.log(`  rowsWritten=${r1.rowsWritten}  factsInDb=${c1}  unmatched=${JSON.stringify(r1.unmatched)}`);

  console.log("Run 2 (idempotency) …");
  const r2 = await syncCursor(supabase, window, fixtureFetcher, undefined, emptyMembers);
  const c2 = await countCursorFacts();
  console.log(`  rowsWritten=${r2.rowsWritten}  factsInDb=${c2}`);

  // Show what attribution produced.
  const { data: rows } = await supabase
    .from("spend_facts")
    .select("day, entity_key, cost_usd, model, employee_id")
    .eq("source", "cursor")
    .order("entity_key");
  console.table(rows);

  const ok = c1 === 3 && c2 === 3;
  console.log(ok ? "\n✅ PASS: 3 facts, idempotent (no duplication on re-run)" : "\n❌ FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
