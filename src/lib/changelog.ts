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
    date: "2026-10-08",
    title: "See which Slack spend summaries get opened",
    items: [
      "Admins can now see on Data → Notifications which Slack spend summaries were opened in the dashboard, and the share opened over the last 30 days. It counts clicks on a summary's Open in dashboard button; test sends aren't counted.",
    ],
  },
  {
    date: "2026-10-08",
    title: "Projections count Claude Team usage properly",
    items: [
      "A Claude Team usage paste only covers the month up to the day it was taken, but projections treated it as the whole month — so the projected total for the month (and the \"on track for\" line in Slack summaries) came out too low. Projections now carry Claude Team's pace forward to the end of the month, blended with last month's, like every other tool. Before the first paste of a month, last month's pace is used.",
    ],
  },
  {
    date: "2026-10-07",
    title: "Choose whether Slack digests include seats and subscriptions",
    items: [
      "Admins can now choose whether Slack spend summaries count seats and subscriptions, under Data → Notifications. By default they don't, so every summary shows spend people actually drive.",
      "Turn them on for everyone, or just for particular teams or people. When they're included, daily and weekly summaries get each day's share of the month's cost and monthly summaries the full amount, matching the dashboard.",
    ],
  },
  {
    date: "2026-10-07",
    title: "Totals on every bar in Slack digest charts",
    items: [
      "Every bar in the Slack spend charts now shows its total, so you can compare periods at a glance. The highlighted bar is the period the big number is about and shows its exact total; earlier bars stay faded with a short total such as $6.2k.",
    ],
  },
  {
    date: "2026-10-07",
    title: "Slack spend digests arrive at 10:30 on weekdays",
    items: [
      "Spend summaries in Slack now arrive at 10:30 in your own time zone, Monday to Friday only, so they come when your Slack notifications are on instead of silently first thing in the morning.",
      "Nothing is sent at weekends. Monday's daily summary covers Friday, and Monday's weekly summary still covers the whole previous week, weekend included.",
      "A Monday's spend is now compared with the Friday before it, not with a near-empty Sunday.",
    ],
  },
  {
    date: "2026-10-07",
    title: "Bigger totals in Slack spend digests",
    items: [
      "Each chart in the Slack spend summary now opens with its total in large orange numbers and the change from last time beside it, in Intent's brand font. The line of text above each chart is now just its label, so the number isn't shown twice.",
    ],
  },
  {
    date: "2026-10-07",
    title: "Claude Team usage lands on the right days",
    items: [
      "A Claude Team usage paste only covers the month up to the day you copied it, so the daily chart now spreads it across those days only. Before, a paste taken on the 7th was spread over the whole month, so the first week looked too low and days that hadn't happened yet already showed Claude spend. Monthly totals don't change.",
    ],
  },
  {
    date: "2026-10-01",
    title: "Test any Slack digest",
    items: [
      "On Data → Notifications you can now preview the Slack summary for any person or any whole team, not just the pilot recipients. Pick one from the new list at the top of the preview.",
      "A new Send test button sends what you're previewing to yourself, straight to that person, or to anyone you choose. Every test message says it's a test and who sent it, and it never counts as one of the real scheduled summaries.",
    ],
  },
  {
    date: "2026-10-01",
    title: "New joiners back on the dashboard",
    items: [
      "The nightly sync of people and teams had been stuck since late July because one person's email address changed. It's fixed: everyone who joined since then appears again, team moves and leavers are up to date, and their spend moves from Unmatched to their name.",
    ],
  },
  {
    date: "2026-10-01",
    title: "Slack spend digests (setup)",
    items: [
      "Admins have a new Data → Notifications tab to choose who gets a Slack summary of their AI spend — daily, weekly or monthly — with managers also seeing everyone who reports to them.",
      "A preview shows exactly what each person would get, with a small chart per section, and can be sent to yourself first. Messages only go out once the pilot is switched on.",
    ],
  },
  {
    date: "2026-09-30",
    title: "Tidier API breakdowns",
    items: [
      "The API page now lists only line items with actual spend. Vercel reports dozens of usage lines at $0.00, which are now hidden; the totals are unchanged.",
    ],
  },
  {
    date: "2026-09-29",
    title: "Hide the menu",
    items: [
      "The round ‹› button on the edge of the left menu hides it, giving the page the full width of the screen. Click it again to bring the menu back.",
      "Your choice is remembered in this browser. The menu now also stays in place as you scroll down long pages.",
    ],
  },
  {
    date: "2026-09-28",
    title: "ChatGPT Premium seats",
    items: [
      "ChatGPT Business now has Standard ($25) and Premium ($125) seats, like Claude Team. Upload the workspace members CSV on Data → Imports to set each person's licence level — Premium holders are then charged $125 on their own row and their team's, instead of everyone counting as a $25 seat.",
      "Who holds a seat still comes from the Okta access-chatgpt group each night; the upload only sets the level. Upload again whenever someone moves between Standard and Premium.",
      "Monthly seat entries for ChatGPT now take separate Standard and Premium counts, the same way Claude's do. Earlier ChatGPT entries are now listed as Standard.",
    ],
  },
  {
    date: "2026-09-12",
    title: "Trends (beta)",
    items: [
      "Explore pages now have a Trends section showing how the selected period moved against the previous one: the overall change, the biggest increases and decreases (teams on the company page, people and tools on a team page, vendors and models on a person page), anything spending for the first time, and anything that has gone quiet.",
      "Month, quarter and year views also list notable days — days where usage spend ran well above a typical day in that period — with who drove them.",
      "A period that is still in progress is compared like-for-like: the same number of elapsed days on each side, with seats and subscriptions left out so a half-finished month doesn't read as a drop.",
      "It's marked beta because the thresholds may still change. There's nothing on the All time view, since there's no earlier period to compare with.",
    ],
  },
  {
    date: "2026-09-11",
    title: "Day and week views",
    items: [
      "The period picker now offers Day and Week alongside Month, Quarter, Year and All time — on Explore, API, Cursor and OpenRouter. Weeks run Monday to Sunday.",
      "A single day's chart would be one lone bar, so the Day view charts the fortnight leading up to the day you picked, with that day highlighted. The totals and breakdown beside it still cover the selected day alone.",
      "Seats and subscriptions are billed by the month, so on day and week views they're spread evenly across that month's days — a week that doesn't happen to include the 1st still shows its share of them, instead of reading as free.",
      "Day and week views don't show a projection: the forecast works in whole months, and a few days of spend isn't enough to forecast from.",
      "Two labels are clearer: 'Where it's going' is now 'Breakdown', and the 'Total to date' tile is now 'All time'.",
    ],
  },
  {
    date: "2026-08-08",
    title: "OpenRouter chart shows the subscription base",
    items: [
      "The OpenRouter spend chart now includes the monthly platform subscription, spread evenly across the month's days like Explore does — so every day shows the flat base with usage stacked on top, instead of empty space on days without API calls. The Spend tile includes it too, noted separately.",
    ],
  },
  {
    date: "2026-08-07",
    title: "OpenRouter: people and workspace keys listed separately",
    items: [
      "The OpenRouter page's 'By person' list no longer mixes in workspace-owned API keys — those now have their own 'Workspace keys' panel, so the person list is actually people.",
      "The OpenRouter spend chart now matches the Explore trend's styling (same axis, tooltip with total, and bar look), and long model lists expand in place instead of truncating.",
    ],
  },
  {
    date: "2026-08-06",
    title: "OpenRouter spend & usage",
    items: [
      "New OpenRouter page: spend, tokens, and requests by model and by person, with the same month/quarter/year period picker as the rest of the dashboard.",
      "OpenRouter spend syncs nightly and is attributed to people via their OpenRouter organization email, so it also shows up in Explore under each person and team.",
      "The API page now covers the direct platforms only (Anthropic, OpenAI — kept as the historical record as they're wound down in favour of OpenRouter); OpenRouter lives on its own page rather than appearing in both.",
      "A recurring tool cost can now be filed under a real vendor instead of 'Other tools' — so a platform fee (like OpenRouter's monthly subscription) and its usage spend show as one vendor row in Explore, split into Subscription and API, instead of two rows with the same name.",
      "The OpenRouter spend-over-time chart shows one bar per day or month, starting at the first date with data — the per-model split lives in the 'By model' list (where dated model snapshots now merge into their base model).",
      "In Explore's by-vendor trend, fixed costs (seats and subscriptions) now stack at the bottom of each bar and usage-based spend on top — the flat base reads as the floor, with day-to-day variation visible above it.",
      "OpenRouter usage is now tracked per workspace: usage from workspace-owned API keys (not tied to a person) attributes to the workspace's department — workspaces map to departments on the Data → Tools page, defaulting to their own name. Each person's row on the OpenRouter page now also shows which models they used.",
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
