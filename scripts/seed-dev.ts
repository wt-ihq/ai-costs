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
import { normalizeAnthropic } from "@/lib/ingest/normalizers/anthropic";
import { normalizeOpenAI } from "@/lib/ingest/normalizers/openai";
import { cursorUsageFixture } from "@/lib/ingest/fixtures/cursor-usage";
import { anthropicCostFixture } from "@/lib/ingest/fixtures/anthropic-cost";
import { openaiCostFixture } from "@/lib/ingest/fixtures/openai-cost";
import { normalizeHibob } from "@/lib/ingest/normalizers/hibob";
import { attachEmployees, upsertSpendFacts, loadEmployees, upsertEmployees, type ResolvedFact } from "@/lib/ingest/persist";
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

  // Employees flow through the HiBob normalizer (the identity spine). In dev we
  // synthesise a HiBob payload from the roster with dev-assigned departments;
  // the real HiBob fetch (sources/hibob.ts) needs service-user creds.
  const hibobPayload = {
    employees: roster.seats.map((s) => ({
      id: `hibob-${s.email}`,
      email: s.email,
      displayName: s.fullName,
      work: { department: deptFor(s.email), site: "London" },
      employmentStatus: "Active",
    })),
  };
  await upsertEmployees(
    supabase,
    normalizeHibob(hibobPayload) as unknown as Record<string, unknown>[],
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

  // 4) Cursor metered (fixture) — email-keyed.
  const cursor = normalizeCursor(cursorUsageFixture);

  const emailKeyed = [...seatFacts, ...claudeOverage, ...cursor];
  const { facts, unmatched } = attachEmployees(emailKeyed, employees);

  // 5) API platforms — keyed by api key / project; attributed to the
  // key/project OWNER (not an end-user email). Seed the registry + facts.
  const keyOwner: Record<string, string> = {
    "anthropic:ak_prod_ingest": "jonathan.lakin@intenthq.com",
    "anthropic:ak_research": "gary.kimmelman@intenthq.com",
    "openai:proj_search": "kai.kashefi@intenthq.com",
    "openai:proj_assistant": "albert.pastrana@intenthq.com",
  };
  await supabase.from("api_keys").insert([
    { vendor: "anthropic", external_key_id: "ak_prod_ingest", name: "Prod ingest key", created_by_email: keyOwner["anthropic:ak_prod_ingest"], owner_employee_id: idByEmail.get(keyOwner["anthropic:ak_prod_ingest"]) },
    { vendor: "anthropic", external_key_id: "ak_research", name: "Research key", created_by_email: keyOwner["anthropic:ak_research"], owner_employee_id: idByEmail.get(keyOwner["anthropic:ak_research"]) },
  ]);
  await supabase.from("projects").insert([
    { vendor: "openai", external_id: "proj_search", name: "Search project", created_by_email: keyOwner["openai:proj_search"], owner_employee_id: idByEmail.get(keyOwner["openai:proj_search"]) },
    { vendor: "openai", external_id: "proj_assistant", name: "Assistant project", created_by_email: keyOwner["openai:proj_assistant"], owner_employee_id: idByEmail.get(keyOwner["openai:proj_assistant"]) },
  ]);

  const platformFacts = [
    ...normalizeAnthropic(anthropicCostFixture),
    ...normalizeOpenAI(openaiCostFixture),
  ];
  const platformResolved: ResolvedFact[] = platformFacts.map((f) => ({
    ...f,
    employeeId: idByEmail.get(keyOwner[`${f.source}:${f.entityKey}`]) ?? null,
  }));

  const written = await upsertSpendFacts(supabase, [...facts, ...platformResolved]);

  console.log(`\nseeded ${written} facts (${seatFacts.length} seat, ${claudeOverage.length} overage, ${cursor.length + platformFacts.length} metered)`);
  console.log(`unmatched entity keys: ${unmatched.length}`);
  const { count } = await supabase.from("spend_facts").select("*", { count: "exact", head: true });
  console.log(`✅ spend_facts now holds ${count} rows`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
