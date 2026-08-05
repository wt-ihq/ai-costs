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
    date: "2026-08-06",
    title: "OpenRouter spend & usage",
    items: [
      "New OpenRouter page: spend, tokens, and requests by model and by person, with the same month/quarter/year period picker as the rest of the dashboard.",
      "OpenRouter spend syncs nightly and is attributed to people via their OpenRouter organization email, so it also shows up in Explore under each person and team, and on the API page alongside Anthropic and OpenAI.",
      "A recurring tool cost can now be filed under a real vendor instead of 'Other tools' — so a platform fee (like OpenRouter's monthly subscription) and its usage spend show as one vendor row in Explore, split into Subscription and API, instead of two rows with the same name.",
      "The OpenRouter spend-over-time chart now shows the top 8 models and folds the rest into 'Other models' — dozens of dated model snapshots (which now merge into their base model) had crowded the chart out of view.",
    ],
  },
  {
    date: "2026-08-05",
    title: "Other AI tools: real reasons when an entry won't save",
    items: [
      "Adding or ending a recurring tool cost used to fail with an unreadable technical message that hid the actual reason. The reason is now shown — for example that the end month falls before the start month, which is easy to do when a contract runs into the following year.",
      "That month mix-up is now flagged as you type, before you press Add entry.",
    ],
  },
  {
    date: "2026-07-31",
    title: "Clearer 'Latest data' for Claude Team and ChatGPT Business",
    items: [
      "Data Health now shows seat coverage and usage coverage as separate dates for Claude Team and ChatGPT Business. Because both sources date their monthly figures to the 1st, one combined date looked identical whether or not that month's usage had been imported — the nightly seat sync alone was enough to make the source look up to date.",
      "If the usage import is missing or a month behind the seats, that date is now highlighted, so a forgotten paste or export is visible at a glance.",
    ],
  },
  {
    date: "2026-07-17",
    title: "Smarter projections",
    items: [
      "Projections now respect each source's own data horizon — a credits export imported through the 10th no longer waters down that source's daily rate with days it knows nothing about.",
      "Each source's recent pace is balanced against last month's, so a couple of unusual days early in a month no longer swing the whole forecast.",
      "Forecasts now follow the direction of travel: a vendor whose spend has been falling for months projects downward (and rising spend projects upward), with sensible limits so one trend can't run away.",
      "Explore now opens on the Year view.",
      "Projections now show their honest range: a low–high spread under the Projected tile and a shaded band around the dashed trend line, spanning the model's conservative and aggressive readings.",
      "Data Health and Imports are now one tabbed 'Data' page — Health, Imports, Tools & projects, and Sync — so the import workflow no longer lives on one very long page. Old links redirect.",
      "Month and quarter charts now spread seats, subscriptions, and monthly imports evenly across the month instead of piling them all on the 1st.",
    ],
  },
  {
    date: "2026-07-15",
    title: "Projected spend + Vercel sync",
    items: [
      "New 'Projected' tile on Explore: a forecast to the end of the selected period — month, quarter, or year — with a comparison to the previous one. Seats and subscriptions are counted exactly; usage is projected from the recent daily rate.",
      "Year and All-time trend charts now extend three months ahead with a dashed projection line, so growth is visible before the money is spent.",
      "The Teams list can now be sorted by cost per head as well as total spend.",
      "Removed the 'idle seat' tag from People lists — plan usage isn't metered, so having no usage-based spend doesn't mean a seat is unused.",
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
