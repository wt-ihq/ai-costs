import type { OktaUser, OktaUsersResponse } from "@/lib/ingest/normalizers/okta";

/** Injectable so the pipeline can run against fixtures without the network. */
export type OktaFetcher = () => Promise<OktaUsersResponse>;

/**
 * Live fetch from the Okta Users API. Needs OKTA_ORG_URL (e.g.
 * https://intenthq.okta.com) and OKTA_API_TOKEN (an Okta API token; sent as
 * `Authorization: SSWS <token>`).
 *
 * `search=status pr` (status present) returns users of EVERY status, including
 * DEPROVISIONED leavers — the default list omits them, and we keep leavers so
 * historical spend stays attributed. Results paginate via the `Link` header
 * (rel="next"); we follow it until exhausted.
 */
export const fetchOktaUsers: OktaFetcher = async () => {
  const org = process.env.OKTA_ORG_URL;
  const token = process.env.OKTA_API_TOKEN;
  if (!org || !token) throw new Error("OKTA_ORG_URL / OKTA_API_TOKEN not set");

  const base = org.replace(/\/+$/, "");
  let url: string | null = `${base}/api/v1/users?search=${encodeURIComponent("status pr")}&limit=200`;
  const users: OktaUser[] = [];
  while (url) {
    const { page, next } = await getUsersPage(url, token);
    users.push(...page);
    url = next;
  }
  return { users };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET one page, retrying on 429/5xx with exponential backoff (Okta rate-limits
 * per org), and return the parsed users plus the `rel="next"` URL if any.
 */
async function getUsersPage(url: string, token: string): Promise<{ page: OktaUser[]; next: string | null }> {
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `SSWS ${token}` },
    });
    if (res.ok) {
      const page = (await res.json()) as OktaUser[];
      return { page: Array.isArray(page) ? page : [], next: parseNextLink(res.headers.get("link")) };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`Okta users ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(Math.min(1000 * 2 ** attempt, 16_000)); // 1s,2s,4s,8s,16s
  }
}

/** Okta paginates with Link headers: `<url>; rel="next"` (and rel="self"). */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}
