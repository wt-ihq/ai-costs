/**
 * Cursor's Analytics API (model usage, MCP, all by-user endpoints) requires a
 * Cursor **Enterprise** plan — the admin key 401s with "You must be a member of
 * an enterprise team to access this resource" on lower tiers. Intent HQ's team
 * isn't on Enterprise yet, so the page is shown in a greyed "Enterprise only"
 * state and the daily cron skips the `cursor_models` source.
 *
 * Flip this on (set CURSOR_ANALYTICS_ENABLED=true in the Vercel env — no code
 * deploy needed) once the team is upgraded; the page and cron source re-enable
 * automatically.
 */
export const CURSOR_ANALYTICS_ENABLED = process.env.CURSOR_ANALYTICS_ENABLED === "true";
