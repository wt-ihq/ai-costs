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
    date: "2026-07-08",
    title: "Tidier people lists",
    items: [
      "The Cursor 'By person' list now shows each person's active-day count — that's what the list is sorted by.",
      "Long people lists show the top 10 with a 'Show all' toggle.",
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
