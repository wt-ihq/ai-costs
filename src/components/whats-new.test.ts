// SSR smoke test (runs in the node environment, like Next's server render):
// the button must render glowless with the popover closed, and the module
// must not touch window/localStorage during server rendering.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatsNew } from "./whats-new";

describe("WhatsNew (SSR)", () => {
  it("server-renders the closed, glowless state without window access", () => {
    const html = renderToStaticMarkup(createElement(WhatsNew));
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("animate-glow");
    expect(html).not.toContain("role=\"dialog\"");
  });
});
