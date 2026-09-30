import { describe, expect, it } from "vitest";
import { parseMrkdwn } from "./mrkdwn";

describe("parseMrkdwn", () => {
  it("parses bold, line breaks and plain text", () => {
    expect(parseMrkdwn("*YOU*\n*$38.20* usage")).toEqual([
      { t: "bold", v: "YOU" }, { t: "br" }, { t: "bold", v: "$38.20" }, { t: "text", v: " usage" },
    ]);
  });
  it("parses links and decodes entities in their text", () => {
    expect(parseMrkdwn("<https://x.test/a|Tom &amp; &lt;Jerry&gt;> $96")).toEqual([
      { t: "link", href: "https://x.test/a", v: "Tom & <Jerry>" }, { t: "text", v: " $96" },
    ]);
  });
});
