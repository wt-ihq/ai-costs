import type { SpendFact } from "@/lib/types";

/**
 * A normalizer is a PURE function: (raw API response) -> spend_fact rows.
 * Raw payloads are persisted before normalization (spec §6) so a normalizer
 * bug can be fixed and replayed without re-fetching from the vendor.
 *
 * Normalizers must NOT do I/O. Identity resolution (email -> employee) and
 * upserting happen downstream.
 */
export type Normalizer<Raw> = (raw: Raw) => SpendFact[];

/** Thrown when a payload doesn't match the expected vendor shape (spec §8). */
export class SchemaDriftError extends Error {
  constructor(
    public readonly source: string,
    detail: string,
  ) {
    super(`[${source}] schema drift: ${detail}`);
    this.name = "SchemaDriftError";
  }
}
