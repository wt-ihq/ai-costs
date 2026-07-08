import type { Vendor } from "@/lib/types";
import { VENDOR_LABEL } from "@/lib/types";
import type { ShapeFact } from "./shape";

/** Unique vendors present in the facts, sorted by display label. */
export function vendorsInFacts(facts: Pick<ShapeFact, "source">[]): Vendor[] {
  return [...new Set(facts.map((f) => f.source))].sort((a, b) =>
    VENDOR_LABEL[a].localeCompare(VENDOR_LABEL[b]),
  );
}

/** Validate a ?vendor= param against the vendors actually present in scope. */
export function parseVendorParam(param: string | undefined, present: Vendor[]): Vendor | "all" {
  return present.includes(param as Vendor) ? (param as Vendor) : "all";
}
