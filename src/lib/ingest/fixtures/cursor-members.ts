import type { CursorMembersResponse } from "@/lib/ingest/normalizers/cursor";

/**
 * Cursor /teams/members fixture: two active members (one with no usage, the
 * idle seat daily-usage-data would miss), one removed member (skipped), and a
 * mixed-case email (lowercased).
 */
export const cursorMembersFixture: CursorMembersResponse = {
  teamMembers: [
    { id: "m1", email: "Gareth.Jones@intenthq.com", name: "Gareth Jones", role: "admin", isRemoved: false },
    { id: "m2", email: "idle.seat@intenthq.com", name: "Idle Seat", role: "member", isRemoved: false },
    { id: "m3", email: "left@intenthq.com", name: "Former Member", role: "member", isRemoved: true },
  ],
};
