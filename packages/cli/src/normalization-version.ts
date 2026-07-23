/**
 * Increment whenever unchanged provider source must be re-normalized because
 * the canonical projection changed. The value travels through the local
 * manifest, fingerprint probe, mapped payload, and SQLite session head, so a
 * deployment replays each source exactly once through idempotent upserts.
 */
export const NORMALIZATION_VERSION = 2;
