import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src/app/(dashboard)");

/**
 * The dashboard is restricted to admins and the access list. A layout can't
 * enforce that alone (it doesn't re-run on in-app navigation), so every page
 * must call requireDashboardAccess() itself, before it loads anything.
 */
describe("dashboard access gate", () => {
  const pages = readdirSync(DIR, { recursive: true, encoding: "utf8" }).filter((f) => /(^|\/)page\.tsx$/.test(f));

  it("finds the dashboard's pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(7);
  });

  it.each(pages)("%s checks access", (page) => {
    const src = readFileSync(join(DIR, page), "utf8");
    expect(src, `${relative(process.cwd(), join(DIR, page))} must call requireDashboardAccess()`).toMatch(/await requireDashboardAccess\(\)/);
  });

  it("the layout checks access before loading the search index", () => {
    const src = readFileSync(join(DIR, "layout.tsx"), "utf8");
    const gate = src.indexOf("await requireDashboardAccess()");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("getSearchIndexCached()", src.indexOf("export default")));
  });
});
