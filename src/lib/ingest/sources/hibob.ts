import type { HibobResponse } from "@/lib/ingest/normalizers/hibob";

export type HibobFetcher = () => Promise<HibobResponse>;

/**
 * Live fetch from the HiBob People API using service-user credentials
 * (HIBOB_SERVICE_USER / HIBOB_SERVICE_TOKEN, Basic auth).
 *
 * ⚠ Endpoint + field mapping must be confirmed against the tenant (spec §3).
 * The normalizer is fixture-tested; this is the only piece that needs creds.
 */
export const fetchHibobPeople: HibobFetcher = async () => {
  const user = process.env.HIBOB_SERVICE_USER;
  const token = process.env.HIBOB_SERVICE_TOKEN;
  if (!user || !token) throw new Error("HIBOB_SERVICE_USER / HIBOB_SERVICE_TOKEN not set");

  const res = await fetch("https://api.hibob.com/v1/people", {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
    },
  });
  if (!res.ok) throw new Error(`HiBob API ${res.status}: ${await res.text()}`);
  return (await res.json()) as HibobResponse;
};
