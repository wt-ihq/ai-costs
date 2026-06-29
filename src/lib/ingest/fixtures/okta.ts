import type { OktaUsersResponse } from "@/lib/ingest/normalizers/okta";

/**
 * Real-shape Okta Users API fixture: active users + one deprovisioned leaver +
 * one service account with no email (must be skipped). Exercises name
 * derivation, department passthrough, email lowercasing, and leaver dating.
 */
export const oktaUsersFixture: OktaUsersResponse = {
  users: [
    {
      id: "00u1",
      status: "ACTIVE",
      activated: "2019-04-01T00:00:00.000Z",
      statusChanged: "2019-04-01T00:00:00.000Z",
      profile: { firstName: "Gareth", lastName: "Jones", email: "Gareth.Jones@intenthq.com", login: "gareth.jones@intenthq.com", department: "Engineering" },
    },
    {
      id: "00u2",
      status: "ACTIVE",
      activated: "2021-09-13T00:00:00.000Z",
      profile: { displayName: "Tom Reeve", email: "tom.reeve@intenthq.com", login: "tom.reeve@intenthq.com", department: "Product" },
    },
    {
      id: "00u3",
      status: "DEPROVISIONED",
      activated: "2018-01-10T00:00:00.000Z",
      statusChanged: "2026-03-31T00:00:00.000Z",
      profile: { firstName: "Former", lastName: "Person", email: "leaver@intenthq.com", login: "leaver@intenthq.com", department: "Sales" },
    },
    {
      // Service account: no email/login → skipped, not an error.
      id: "00u4",
      status: "ACTIVE",
      profile: { firstName: "CI", lastName: "Bot" },
    },
  ],
};
