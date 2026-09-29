/**
 * Left menu show/hide preference. Kept in a cookie (not localStorage) so the
 * dashboard layout reads it on the server and renders the right state first —
 * no flash of the open menu on load.
 */
export const SIDEBAR_COOKIE = "sidebar";

const ONE_YEAR_S = 60 * 60 * 24 * 365;

/** Shown unless the cookie explicitly says collapsed. */
export function isSidebarCollapsed(value: string | undefined): boolean {
  return value === "collapsed";
}

/** The `document.cookie` assignment for a state. */
export function sidebarCookie(collapsed: boolean): string {
  return `${SIDEBAR_COOKIE}=${collapsed ? "collapsed" : "expanded"}; path=/; max-age=${ONE_YEAR_S}; samesite=lax`;
}
