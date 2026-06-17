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
  readonly matches: readonly SearchMatch[];
  readonly diagnostics: {
    readonly textSearched: boolean;
    readonly semanticSearched: boolean;
    readonly semanticStatus: "ready" | "unavailable" | "misconfigured";
    readonly embeddingDimensions?: number;
    readonly error?: string;
  };
};

type SearchMatch = {
  readonly text?: unknown;
  readonly textRank?: unknown;
  readonly score?: unknown;
};

const LEXICAL_PROBES = [
  {
    query: "stop hook blocked termination",
    evidence: [/stop hook/i, /block/i, /termination/i],
  },
  { query: "terminal", evidence: [/terminal/i] },
  { query: "Done Reading", evidence: [/done/i, /read/i] },
] as const;

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

const assertSubstantiveHits = (
  mode: string,
  probe: (typeof LEXICAL_PROBES)[number],
  report: SearchReport,
): void => {
  const { query } = probe;
  assertReport(mode, report);
  if (!report.diagnostics.textSearched) {
    throw new Error(`${mode}/${query}: text search did not run`);
  }
  if (report.matches.length === 0) {
    throw new Error(`${mode}/${query}: expected at least one lexical hit`);
  }
  const first = report.matches[0]!;
  const firstText = first.text;
  if (typeof firstText !== "string" || firstText.trim().length < 20) {
    throw new Error(`${mode}/${query}: top hit is not substantive text`);
  }
  if (typeof first.score !== "number" || !Number.isFinite(first.score)) {
    throw new Error(`${mode}/${query}: top hit does not expose a finite score`);
  }
  if (typeof first.textRank !== "number" || !Number.isFinite(first.textRank)) {
    throw new Error(`${mode}/${query}: top hit does not expose a finite textRank`);
  }
  for (const evidence of probe.evidence) {
    if (!evidence.test(firstText)) {
      throw new Error(`${mode}/${query}: top hit does not contain expected evidence ${String(evidence)}`);
    }
  }
};

const assertSemanticReport = (report: SearchReport): void => {
  assertReport("semantic", report);
  if (report.diagnostics.semanticStatus !== "unavailable") {
    throw new Error(
      `semantic: expected unavailable without Gemini credentials, got ${report.diagnostics.semanticStatus}`,
    );
  }
  if (report.diagnostics.semanticSearched) {
    throw new Error("semantic: unavailable report unexpectedly searched");
  }
  if (report.matches.length !== 0) {
    throw new Error("semantic: unavailable report returned matches");
  }
};

const main = async () => {
  console.log("LANCEDB SEARCH SURFACE — live Convex actions\n");
  const client = convexClient();
  const secret = requireActionCredential();

  for (const probe of LEXICAL_PROBES) {
    const { query } = probe;
    const text = (await client.action(api.search.searchLexical, { secret, query, limit: 3 })) as SearchReport;
    assertSubstantiveHits("text", probe, text);
    console.log(
      `text     query=${JSON.stringify(query)} matches=${text.matches.length} semantic=${text.diagnostics.semanticStatus} textSearched=${text.diagnostics.textSearched}`,
    );
  }

  const semantic = (await client.action(api.search.searchSemantic, {
    secret,
    query: LEXICAL_PROBES[0].query,
    limit: 3,
  })) as SearchReport;
  assertSemanticReport(semantic);
  console.log(
    `semantic matches=${semantic.matches.length} semantic=${semantic.diagnostics.semanticStatus} semanticSearched=${semantic.diagnostics.semanticSearched}`,
  );

  for (const probe of LEXICAL_PROBES) {
    const { query } = probe;
    const fusion = (await client.action(api.search.searchFusion, { secret, query, limit: 3 })) as SearchReport;
    assertSubstantiveHits("fusion", probe, fusion);
    console.log(
      `fusion   query=${JSON.stringify(query)} matches=${fusion.matches.length} semantic=${fusion.diagnostics.semanticStatus} textSearched=${fusion.diagnostics.textSearched} semanticSearched=${fusion.diagnostics.semanticSearched}`,
    );
  }

  console.log("\nLANCEDB SEARCH SURFACE: PASS — lexical and fusion probes returned substantive hits; semantic returned a stable report.");
};

await main();
