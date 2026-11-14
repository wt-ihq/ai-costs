import { UNASSIGNED_PREFIX } from "@/lib/ingest/seat-months";
import type { RawScope } from "./build";
import type { ShapeFact } from "./shape";

/**
 * The company and team pages never show a model or an API key: they add facts up by day, vendor,
 * cost type, person and team. So before a scope is cached and sent to the browser, rows that
 * differ only in a field those pages don't read are summed into one. Spend facts are stored per
 * (day, entity, model) — a person's day of Cursor on-demand usage is a row per model, a Vercel
 * project's day a row per billing line — and every one of those rows was cached, downloaded,
 * unpacked and re-added in the browser on each view.
 *
 * What the pages do read, and so what a row keeps:
 * - `model` names the tool of an "other" (recurring) cost, and labels a person-less row in a
 *   team's "Tools & infrastructure" list — except Vercel rows (listed by project) and OpenRouter
 *   workspace usage (listed by workspace), which are the bulk of the person-less rows.
 * - `entityKey` tells person-less rows apart (project, workspace, "unkeyed", service account…)
 *   and marks backfilled "unassigned seats".
 * Everything else is blanked. Postgres applies the same rule when it sums a scope's window
 * (migration 0030, `explore_facts_rollup`): CHANGE THE TWO TOGETHER — the SQL may keep more than
 * this does, never less, because what it has summed away can't be recovered here. rollup.test.ts holds the roll-up to giving `buildExploreData`
 * exactly the same answer as the raw facts; a shaper that starts reading a blanked field on
 * these pages must keep it here.
 */
function rollUpKey(f: ShapeFact): { model: string; entityKey: string } {
  const personLess = !f.employeeId;
  const keepModel =
    f.source === "other" ||
    (personLess && f.source !== "vercel" && !(f.source === "openrouter" && f.costType === "metered"));
  const keepKey = personLess || f.entityKey.startsWith(UNASSIGNED_PREFIX);
  return { model: keepModel ? f.model : "", entityKey: keepKey ? f.entityKey : "" };
}

/** Pure: sum facts that the company and team pages can't tell apart. Order of first appearance is kept. */
export function rollUpFacts(facts: ShapeFact[]): ShapeFact[] {
  const groups = new Map<string, ShapeFact>();
  for (const f of facts) {
    const { model, entityKey } = rollUpKey(f);
    // \u0001 can't occur in any of these fields, so distinct tuples never share a key.
    const key = [f.day, f.source, f.costType, f.employeeId ?? "", f.department ?? "\u0002", f.fullName ?? "\u0002", entityKey, model].join("\u0001");
    const group = groups.get(key);
    if (group) group.costUsd += f.costUsd;
    else groups.set(key, { ...f, model, entityKey });
  }
  return [...groups.values()];
}

/** Roll up a company or team scope for the cache and the wire. A person's page lists line items per model and key, so it stays as it is. */
export function rollUpScope(scope: RawScope): RawScope {
  if (scope.kind === "person") return scope;
  return { ...scope, facts: rollUpFacts(scope.facts) };
}
