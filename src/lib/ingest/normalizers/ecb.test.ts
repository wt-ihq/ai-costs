import { describe, expect, it } from "vitest";
import { SchemaDriftError } from "@/lib/ingest/types";
import { ecbUsdRates, parseEcbDaily } from "./ecb";

/** The real shape of https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml (trimmed). */
const xml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>${inner}</Cube>
</gesmes:Envelope>`;
const daily = xml(`
    <Cube time='2026-10-16'>
      <Cube currency='USD' rate='1.1253'/>
      <Cube currency='JPY' rate='177.82'/>
      <Cube currency='GBP' rate='0.84385'/>
    </Cube>`);

describe("parseEcbDaily", () => {
  it("reads the reference date and every currency's rate per euro", () => {
    expect(parseEcbDaily(daily)).toEqual({ date: "2026-10-16", perEur: { USD: 1.1253, JPY: 177.82, GBP: 0.84385 } });
  });

  it("accepts double quotes too", () => {
    expect(parseEcbDaily(xml(`<Cube time="2026-10-16"><Cube currency="USD" rate="1.1"/></Cube>`)).perEur.USD).toBe(1.1);
  });

  it("fails loudly on a file without a date or rates", () => {
    expect(() => parseEcbDaily("<html>maintenance</html>")).toThrow(SchemaDriftError);
    expect(() => parseEcbDaily(xml(`<Cube time='2026-10-16'></Cube>`))).toThrow(SchemaDriftError);
  });
});

describe("ecbUsdRates", () => {
  it("gives dollars per pound (via the euro) and per euro, to six places", () => {
    expect(ecbUsdRates(parseEcbDaily(daily))).toEqual([
      { currency: "GBP", usdPerUnit: 1.333531, date: "2026-10-16" },
      { currency: "EUR", usdPerUnit: 1.1253, date: "2026-10-16" },
    ]);
  });

  it("fails loudly when the dollar or the pound is missing, rather than storing nonsense", () => {
    expect(() => ecbUsdRates({ date: "2026-10-16", perEur: { GBP: 0.84 } })).toThrow(SchemaDriftError);
    expect(() => ecbUsdRates({ date: "2026-10-16", perEur: { USD: 1.12 } })).toThrow(SchemaDriftError);
    expect(() => ecbUsdRates({ date: "2026-10-16", perEur: { USD: 1.12, GBP: 0 } })).toThrow(SchemaDriftError);
  });
});
