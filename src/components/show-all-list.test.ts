// SSR smoke test: collapsed state renders `limit` rows + the toggle;
// short lists render fully with no toggle.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShowAllList } from "./show-all-list";

const items = (n: number) => Array.from({ length: n }, (_, i) => `item-${i}`);
const renderItem = (s: string) => createElement("li", { key: s }, s);

describe("ShowAllList (SSR)", () => {
  it("renders only the first `limit` items plus a Show all toggle", () => {
    const html = renderToStaticMarkup(
      createElement(ShowAllList<string>, { items: items(12), limit: 10, render: renderItem }),
    );
    expect(html.match(/<li>/g)).toHaveLength(10);
    expect(html).toContain("Show all 12");
  });

  it("renders short lists fully with no toggle", () => {
    const html = renderToStaticMarkup(
      createElement(ShowAllList<string>, { items: items(5), limit: 10, render: renderItem }),
    );
    expect(html.match(/<li>/g)).toHaveLength(5);
    expect(html).not.toContain("Show all");
  });
});
