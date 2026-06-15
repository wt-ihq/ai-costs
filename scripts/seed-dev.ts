/**
 * Dev-only seed: loads the real /reports samples through the actual parsers
 * into the local DB, so the dashboard shows realistic multi-source data.
 * (Reads gitignored PII files; nothing here is committed as data.)
 *
 * Run: npx tsx scripts/seed-dev.ts   (reads .env.local)
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseClaudeRoster } from "@/lib/ingest/parsers/claude-roster";
import { parseClaudeSpend, buildClaudeSpendFacts } from "@/lib/ingest/parsers/claude-spend";
import { buildSeatFacts, type SeatAssignment } from "@/lib/ingest/seats";
import { normalizeCursor } from "@/lib/ingest/normalizers/cursor";
import { cursorUsageFixture } from "@/lib/ingest/fixtures/cursor-usage";
import { attachEmployees, upsertSpendFacts, loadEmployees } from "@/lib/ingest/persist";
import type { SpendFact } from "@/lib/types";

process.loadEnvFile(".env.local");
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const DEPTS = ["Engineering", "Product", "Data", "Design", "Sales", "Operations", "Finance"];
function deptFor(email: string): string {
  let h = 0;
  for (const c of email) h = (h + c.charCodeAt(0)) % 9973;
  return DEPTS[h % DEPTS.length];
}

async function main() {
  // Clean slate (child rows before parents).
  for (const t of ["spend_facts", "seat_assignments", "identities", "raw_payloads", "sync_runs"]) {
    await supabase.from(t).delete().neq("id", "00000000-0000-0000-0000-000000000000");
  }
  await supabase.from("employees").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  // 1) Employees + seats from the Claude roster CSV.
  const roster = parseClaudeRoster(readFileSync("reports/claude team.csv", "utf8"));
  console.log(`roster: ${roster.seats.length} seats, ${roster.errors.length} errors`);

  await supabase.from("employees").insert(
    roster.seats.map((s) => ({
      hibob_id: s.email,
      email: s.email,
      full_name: s.fullName,
      department: deptFor(s.email),
      employment_status: "active",
    })),
  );
  const employees = await loadEmployees(supabase);
  const idByEmail = new Map(employees.map((e) => [e.email, e.id]));

  const assignments: SeatAssignment[] = roster.seats.map((s) => ({
    vendor: "claude_team",
    email: s.email,
    seatType: s.seatType,
  }));
  await supabase.from("seat_assignments").insert(
    roster.seats.map((s) => ({
      vendor: "claude_team",
      employee_id: idByEmail.get(s.email),
      seat_type: s.seatType,
      monthly_price_usd: 0, // indicative; facts are priced from seat_prices
      period_start: "2026-06-01",
    })),
  );

  // Pricing + FX from config tables.
  const { data: priceRows } = await supabase.from("seat_prices").select("*");
  const prices = Object.fromEntries(
    (priceRows ?? []).map((p) => [`${p.vendor}:${p.seat_type}`, Number(p.monthly_price_usd)]),
  );
  const { data: fx } = await supabase.from("fx_rates").select("*").eq("currency", "GBP").single();
  const gbpUsd = Number(fx?.usd_per_unit ?? 1.27);

  // 2) Seat facts for the last 3 months (seats recur monthly → a real trend).
  const months = ["2026-04-15", "2026-05-15", "2026-06-15"];
  const seatFacts: SpendFact[] = months.flatMap((m) => buildSeatFacts(assignments, prices, m));

  // 3) Claude overage (MTD, GBP→USD) for the current month.
  const spend = parseClaudeSpend(readFileSync("reports/claude MTD spend.txt", "utf8"));
  const claudeOverage = buildClaudeSpendFacts(spend.rows, "2026-06-15", gbpUsd);
  console.log(`claude MTD: ${spend.rows.length} rows, ${claudeOverage.length} with spend`);

  // 4) Cursor metered (fixture).
  const cursor = normalizeCursor(cursorUsageFixture);

  const all = [...seatFacts, ...claudeOverage, ...cursor];
  const { facts, unmatched } = attachEmployees(all, employees);
  const written = await upsertSpendFacts(supabase, facts);

  console.log(`\nseeded ${written} facts (${seatFacts.length} seat, ${claudeOverage.length} overage, ${cursor.length} metered)`);
  console.log(`unmatched entity keys: ${unmatched.length}`);
  const { count } = await supabase.from("spend_facts").select("*", { count: "exact", head: true });
  console.log(`✅ spend_facts now holds ${count} rows`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
