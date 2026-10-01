/** The mrkdwn subset renderDigest emits: *bold*, <url|text> links and line breaks. */
export type MrkNode = { t: "text"; v: string } | { t: "bold"; v: string } | { t: "link"; href: string; v: string } | { t: "br" };

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const TOKEN = /<([^|>]+)\|([^>]+)>|\*([^*\n]+)\*|\n/g;

/** Parsed into nodes (not HTML) so the preview renders through React's own escaping. */
export function parseMrkdwn(s: string): MrkNode[] {
  const out: MrkNode[] = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: decode(s.slice(last, at)) });
    if (m[1] !== undefined) out.push({ t: "link", href: m[1], v: decode(m[2]) });
    else if (m[3] !== undefined) out.push({ t: "bold", v: decode(m[3]) });
    else out.push({ t: "br" });
    last = at + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: decode(s.slice(last)) });
  return out;
}
