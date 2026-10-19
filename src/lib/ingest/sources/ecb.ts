/** The ECB's euro foreign exchange reference rates for the latest working day: public, no key. */
export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export type EcbFetcher = () => Promise<string>;

export const fetchEcbDaily: EcbFetcher = async () => {
  const res = await fetch(ECB_DAILY_URL, { headers: { Accept: "application/xml" } });
  if (!res.ok) throw new Error(`ECB rates ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
};
