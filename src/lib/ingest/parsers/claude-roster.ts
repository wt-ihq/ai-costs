import type { SeatParseResult, SeatRow } from "./types";

/**
 * Claude Team member roster CSV (reports/claude team.csv).
 * Columns: Name, Email, Role, Status, Seat Tier.
 *
 * This is NOT a spend export — it gives seats + tier only. Seat cost is
 * generated from these rows via per-tier prices (seat_prices). Per-user
 * overage comes separately from the Claude spend dashboard (see claude-spend).
 *
 * Tiers seen in real data: Premium, Standard, Unassigned. "Unassigned" = a
 * member with no paid tier (a seat-hygiene signal), priced at 0.
 */
export function parseClaudeRoster(csv: string): SeatParseResult {
  const seats: SeatRow[] = [];
  const errors: SeatParseResult["errors"] = [];

  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { seats, errors: [{ line: 0, message: "empty or header-only CSV" }] };
  }

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const cEmail = idx("email");
  const cName = idx("name");
  const cRole = idx("role");
  const cStatus = idx("status");
  const cTier = idx("seat tier");

  if (cEmail < 0 || cTier < 0) {
    return {
      seats,
      errors: [{ line: 0, message: "missing required columns: Email, Seat Tier" }],
    };
  }

  lines.slice(1).forEach((line, i) => {
    const lineNo = i + 2;
    const cells = line.split(",").map((c) => c.trim());
    const email = cells[cEmail]?.toLowerCase();
    if (!email || !email.includes("@")) {
      errors.push({ line: lineNo, message: `invalid email: "${cells[cEmail]}"` });
      return;
    }
    seats.push({
      email,
      fullName: cName >= 0 ? cells[cName] : "",
      role: cRole >= 0 ? cells[cRole] : "",
      status: cStatus >= 0 ? cells[cStatus] : "",
      seatType: (cells[cTier] || "unassigned").toLowerCase(),
    });
  });

  return { seats, errors };
}
