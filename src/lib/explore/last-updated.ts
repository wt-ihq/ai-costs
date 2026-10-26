import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import { OTHER_KEY_PREFIX } from "./shape";

/** vendor → the ISO day it was last refreshed, or null when it never was. */
export type LastUpdated = Record<string, string | null>;

/**
 * Where each vendor's "last updated" comes from. Automatic sources: their last
 * successful sync_runs row. Manual imports: the latest paste's data_as_of.
 * Other tools: the nightly "recurring" materialiser.
 */
export const LAST_UPDATED_SIGNAL: Record<Vendor, { table: "sync_runs" | "imports"; source: string }> = {
  cursor: { table: "sync_runs", source: "cursor" },
  anthropic: { table: "sync_runs", source: "anthropic" },
  openai: { table: "sync_runs", source: "openai" },
  vercel: { table: "sync_runs", source: "vercel" },
  openrouter: { table: "sync_runs", source: "openrouter" },
  chatgpt_business: { table: "imports", source: "chatgpt_business" },
  claude_team: { table: "imports", source: "claude_team" },
  other: { table: "sync_runs", source: "recurring" },
};

/**
 * @param syncs   source → finished_at of its last successful sync (timestamptz).
 * @param imports source → data_as_of of its latest import (date).
 */
export function lastUpdatedFrom(syncs: Record<string, string | null>, imports: Record<string, string | null>): LastUpdated {
  const out: LastUpdated = {};
  for (const vendor of Object.keys(VENDOR_LABEL) as Vendor[]) {
    const { table, source } = LAST_UPDATED_SIGNAL[vendor];
    const at = (table === "sync_runs" ? syncs : imports)[source] ?? null;
    out[vendor] = at ? at.slice(0, 10) : null;
  }
  return out;
}

/** "Updated 26 Oct" (year only when it isn't this one) / "Never updated". */
export function lastUpdatedLabel(day: string | null, now: Date = new Date()): string {
  if (!day) return "Never updated";
  const d = new Date(`${day}T00:00:00Z`);
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  const text = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
  return `Updated ${text}`;
}

/** The date for a Breakdown row: a vendor key, or other:<tool> (all tools share the recurring date). Undefined for the rolled-up "__other__" row. */
export function lastUpdatedForNode(nodeKey: string, lastUpdated: LastUpdated): string | null | undefined {
  if (nodeKey.startsWith("__")) return undefined;
  const vendor = nodeKey.startsWith(OTHER_KEY_PREFIX) ? "other" : nodeKey;
  return lastUpdated[vendor] ?? null;
}
