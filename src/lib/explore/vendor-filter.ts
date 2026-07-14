import { dimLabel, OTHER_KEY_PREFIX } from "./shape";
import type { ShapeFact } from "./shape";

/** A concrete vendor, or a first-class tool: `other:<tool display name>`. */
export type VendorKey = string;

export function vendorKeyOf(f: Pick<ShapeFact, "source" | "model">): VendorKey {
  return f.source === "other" ? `${OTHER_KEY_PREFIX}${f.model}` : f.source;
}

/** Unique vendor keys present in the facts, sorted by display label. */
export function vendorsInFacts(facts: Pick<ShapeFact, "source" | "model">[]): VendorKey[] {
  return [...new Set(facts.map(vendorKeyOf))].sort((a, b) =>
    dimLabel("vendor", a).localeCompare(dimLabel("vendor", b)),
  );
}

export function matchesVendorKey(f: Pick<ShapeFact, "source" | "model">, key: VendorKey): boolean {
  return vendorKeyOf(f) === key;
}

/** Validate a ?vendor= param against the keys actually present in scope. */
export function parseVendorParam(param: string | undefined, present: VendorKey[]): VendorKey | "all" {
  return param && present.includes(param) ? param : "all";
}
