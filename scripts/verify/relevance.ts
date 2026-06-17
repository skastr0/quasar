/**
 * BATTERY (r) — LANCEDB SEARCH SURFACE
 *
 * Smoke the live search actions through Convex. This deliberately calls the
 * LanceDB-owned `search:*` actions and never the retired Convex Searchlight/RAG
 * helpers. Semantic search may be unavailable when Gemini credentials are not
 * configured; that is still a valid report shape and must not crash the CLI or
 * backend.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { api } from "../../convex/_generated/api";
import { convexClient } from "./lib/estate";

type SearchReport = {
  readonly matches: readonly unknown[];
  readonly diagnostics: {
    readonly textSearched: boolean;
    readonly semanticSearched: boolean;
    readonly semanticStatus: "ready" | "unavailable" | "misconfigured";
    readonly embeddingDimensions?: number;
    readonly error?: string;
  };
};

const configuredActionCredential = (): string | undefined => {
  const explicit = process.env.QUASAR_ACTION_SECRET;
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();
  const path = resolve(
    process.env.QUASAR_LOCAL_CONVEX_CONFIG ??
      join(process.env.QUASAR_HOME ?? join(homedir(), ".config", "quasar"), "local", "default", "config.json"),
  );
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = (parsed as { actionSecret?: unknown }).actionSecret;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const requireActionCredential = (): string => {
  const credential = configuredActionCredential();
  if (credential !== undefined && credential.length > 0) return credential;
  throw new Error(
    "Search verification requires the action credential from QUASAR_ACTION_SECRET or local Convex config.",
  );
};

const assertReport = (mode: string, report: SearchReport): void => {
  if (!Array.isArray(report.matches)) {
    throw new Error(`${mode}: matches is not an array`);
  }
  if (
    report.diagnostics.semanticStatus !== "ready" &&
    report.diagnostics.semanticStatus !== "unavailable" &&
    report.diagnostics.semanticStatus !== "misconfigured"
  ) {
    throw new Error(`${mode}: invalid semanticStatus ${String(report.diagnostics.semanticStatus)}`);
  }
};

const main = async () => {
  console.log("LANCEDB SEARCH SURFACE — live Convex actions\n");
  const client = convexClient();
  const secret = requireActionCredential();
  const base = { secret, query: "quasar search", limit: 1 };

  const text = (await client.action(api.search.searchLexical, base)) as SearchReport;
  assertReport("text", text);
  console.log(
    `text     matches=${text.matches.length} semantic=${text.diagnostics.semanticStatus} textSearched=${text.diagnostics.textSearched}`,
  );

  const semantic = (await client.action(api.search.searchSemantic, base)) as SearchReport;
  assertReport("semantic", semantic);
  console.log(
    `semantic matches=${semantic.matches.length} semantic=${semantic.diagnostics.semanticStatus} semanticSearched=${semantic.diagnostics.semanticSearched}`,
  );

  const fusion = (await client.action(api.search.searchFusion, base)) as SearchReport;
  assertReport("fusion", fusion);
  console.log(
    `fusion   matches=${fusion.matches.length} semantic=${fusion.diagnostics.semanticStatus} textSearched=${fusion.diagnostics.textSearched} semanticSearched=${fusion.diagnostics.semanticSearched}`,
  );

  console.log("\nLANCEDB SEARCH SURFACE: PASS — text, semantic, and fusion actions returned stable reports.");
};

await main();
