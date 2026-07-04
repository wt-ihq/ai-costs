import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * CRON_SECRET gate for the cron routes. Fails CLOSED: an environment without
 * the secret set (e.g. a misconfigured preview deployment) rejects every
 * request instead of becoming a public sync/backfill endpoint. Comparison is
 * timing-safe (hash both sides to equal length first).
 */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const provided = createHash("sha256").update(req.headers.get("authorization") ?? "").digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(provided, expected);
}
