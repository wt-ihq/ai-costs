/**
 * Hand-curated release notes for the "What's new" popover, newest first.
 * Entries are plain English for dashboard users — features and fixes only.
 * `date` (ISO day) doubles as the entry's identity for seen-tracking.
 */
export type ChangelogEntry = {
  date: string;
  title: string;
  items: string[];
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-07-15",
    title: "Projected spend + Vercel sync",
    items: [
      "New 'Projected' tile on Explore: a forecast to the end of the selected period — month, quarter, or year — with a comparison to the previous one. Seats and subscriptions are counted exactly; usage is projected from the recent daily rate.",
      "Year and All-time trend charts now extend three months ahead with a dashed projection line, so growth is visible before the money is spent.",
      "Vercel hosting costs now flow in automatically from Vercel's billing API — plan charges as Subscription, usage as API, per project per day.",
      "Assign each Vercel project to a department on the Imports page and its cost lands on that team's row; team pages list projects under 'Tools & infrastructure' beside recurring tools.",
      "Pages load much faster: the dashboard now caches its data between changes instead of re-reading everything on every view — syncs and imports refresh it instantly.",
    ],
  },
  {
    date: "2026-07-14",
    title: "Seats sync themselves",
    items: [
      "ChatGPT seat members now come straight from Okta (the access-chatgpt group), refreshed nightly — the end-of-month membership becomes that month's seat count, with exact person attribution. The analytics-table paste is gone.",
      "Your manual monthly seat entry still wins when present — synced members share the entered total.",
      "The API platforms are now labelled 'Anthropic API' and 'OpenAI API' to distinguish them from Claude Team and ChatGPT Business.",
      "Seat cost now always sits at the base of Explore's stacked bars and leads the team/person split bars, so charts read consistently (fixed cost first, usage on top).",
      "Claude seat members now sync nightly from Okta (the access-claude group), with each person's standard or premium tier applied automatically — the roster CSV is only needed when a tier changes.",
      "You can backfill any month's Claude seat costs per tier, entered in £ with your exchange rate (stored alongside the $ conversion).",
      "The most recent price you enter becomes the default seat price for later months — for both Claude and ChatGPT.",
      "Explore's team list now shows backfilled seat months as their own 'Shared seats' row instead of swelling 'Unattributed' — what's left in Unattributed is genuinely unmatched and worth fixing (see Data Health).",
      "Data Health no longer offers to assign person-less spend (unassigned seats, org-level costs) to individuals — it moved to its own explained list, and a new section shows exactly who has no department in Okta.",
      "You can now add any other AI tool's costs by hand — a monthly price or an up-front contract spread across its months, in £, $, or € — attributed to the department of your choice. Each tool shows up in Explore as its own vendor with its own colour.",
      "Tool costs now show as their own 'Subscription' category (violet) instead of blending into Seat, and team pages list tools separately from people.",
      "Small polish: the Explore header now says 'drill into a team or person', and the redundant lone breadcrumb on the company page is gone.",
    ],
  },
  {
    date: "2026-07-13",
    title: "ChatGPT credit usage, per person per day",
    items: [
      "New import: the OpenAI credit-usage CSV (from the admin billing page) brings daily, per-person, per-model ChatGPT credit spend into the dashboard — Codex vs chat usage is now visible everywhere.",
      "ChatGPT overage now counts only additional (paid) credits — bundled seat credits are no longer misbooked as extra spend.",
      "The ChatGPT paste import now handles seats only, and the import-coverage table shows seats and credits separately.",
      "The credits import card shows how far imported data reaches and where to download the export.",
      "You can now enter a month's ChatGPT seat count and per-seat price by hand (default $25, override per month) — pasted members share the entered total, and any extra seats show as 'unassigned seats'.",
      "Fixed the credits import failing on Codex task rows (their usage counts can be fractional).",
    ],
  },
  {
    date: "2026-07-08",
    title: "Tidier people lists",
    items: [
      "The Cursor 'By person' list now shows each person's active-day count — that's what the list is sorted by.",
      "Long people lists show the top 10 with a 'Show all' toggle.",
      "Explore can now be filtered to a single vendor — use the chips at the top or click a vendor in the composition chart; the filter follows you as you drill into teams and people.",
      "Department and people bars now use the exact same colors as the charts.",
      "The Imports page now shows which months each manual source has been imported for, and the ChatGPT import explains how to export a single calendar month (the rolling 1M window double-counts).",
    ],
  },
  {
    date: "2026-07-07",
    title: "Sturdier syncs, safer sign-in — and this panel",
    items: [
      "Added this What's new panel — the sparkle glows when there's something you haven't seen.",
      "Pages now show a friendly error screen instead of crashing when something goes wrong.",
      "Fixed totals that could drop rows for teams with many people.",
      "Nightly data syncs now recover cleanly if a vendor API fails mid-run, and sign-in is locked down tighter.",
      "API Platforms now shows spend per vendor (click a vendor tile to filter) and spend per person.",
      "Cursor Usage now shows spend: totals for the period, overage by model, and spend per person.",
    ],
  },
  {
    date: "2026-06-30",
    title: "Better Cursor numbers & clearer charts",
    items: [
      "Cursor seat counts now come straight from the team roster, so idle seats are no longer missed.",
      "Ranked spend bars are color-coded by what the money went on (seats, overage, API).",
      "Employee data now comes from Okta, so team assignments stay in sync automatically.",
      "Data Health cross-checks our Cursor totals against Cursor's own numbers.",
    ],
  },
  {
    date: "2026-06-22",
    title: "Find anyone fast",
    items: [
      "New search box in the top bar — jump straight to any team or person.",
      "Month labels on trend charts no longer overlap on narrow screens.",
    ],
  },
];

/** True when the newest entry is newer than what this browser last saw. */
export function hasUnseen(latestDate: string, lastSeen: string | null): boolean {
  if (!lastSeen) return true;
  // ISO YYYY-MM-DD dates compare correctly as strings.
  return lastSeen < latestDate;
}
