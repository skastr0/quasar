import { ampAdapter } from "./amp";
import { antigravityAdapter } from "./antigravity";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { devinAdapter } from "./devin";
import { grokAdapter } from "./grok";
import { hermesAdapter } from "./hermes";
import { kimiAdapter } from "./kimi";
import { ompAdapter } from "./omp";
import { piAdapter } from "./pi";
import { opencodeAdapter } from "./opencode";

/**
 * Stable adapters included in `ingest --provider all`.
 *
 * Amp is intentionally gated out of this set (reachable only via
 * `--provider amp`) until dogfood promotion. This is a bounded temporary
 * coexistence — not a permanent two-tier architecture.
 *
 * Promotion criterion (all required; human signoff, not agent-promotable):
 *   1. ≥3 successful live `ingest --provider amp` dogfood runs against a real
 *      amp corpus.
 *   2. Zero fail-closed diagnostics attributable to Amp schema/CLI contract
 *      mismatches on those runs.
 *   3. Project-maintainer signoff that remote watermark + fingerprint behavior
 *      is acceptable in production.
 *
 * On promotion: move `ampAdapter` into this array, set `stable: true`, delete
 * `gatedAdapters`, and drop this comment block. Owner: project maintainer.
 * Durable owner-of-record: Forge backlog glyph QSR-275 ("Promote Amp adapter
 * from gatedAdapters into stableAdapters"). Promotion is human-signoff only —
 * never agent-promoted.
 */
export const stableAdapters = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  grokAdapter,
  hermesAdapter,
  kimiAdapter,
  antigravityAdapter,
  ompAdapter,
  piAdapter,
  cursorAdapter,
  devinAdapter,
] as const;

/** Temporary gate — see promotion criterion on `stableAdapters`. */
const gatedAdapters = [ampAdapter] as const;

export const adaptersByProvider = new Map(
  [...stableAdapters, ...gatedAdapters].map((adapter) => [adapter.provider, adapter]),
);
