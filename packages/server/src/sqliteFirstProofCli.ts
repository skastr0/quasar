#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { embeddingProfileFromEnv } from "./embeddingProfiles";
import { runSqliteFirstProof } from "./sqliteFirstProof";

const args = process.argv.slice(2);

const valueFor = (name: string, fallback?: string): string | undefined => {
  const index = args.lastIndexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};

const hasFlag = (name: string): boolean => args.includes(name);

const numberFor = (name: string, fallback: number): number => {
  const raw = valueFor(name);
  if (raw === undefined) return fallback;
  if (raw === "all") return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const usage = () => {
  console.log(`Usage:
  bun run proof:sqlite-first --source-db /path/to/quasar.sqlite [--work-db /tmp/proof.sqlite] [--out docs/proofs/sqlite-first-proof.json]

Options:
  --source-db       Required. SQLite truth database to snapshot with VACUUM INTO.
  --work-db         Optional. Destination proof DB. Must not already exist.
  --out             Optional JSON report path. Defaults under docs/proofs/.
  --query           Repeatable FTS query. Defaults to a small built-in set.
  --vector-limit    Rows to materialize into proof_message_vectors. Default 20000; use "all" for all rows.
  --scan-limit      Rows to pure-JS exact-scan. Defaults to vector-limit.

The source database is opened read-only. FTS and vector proof tables are created only in the work DB.
`);
};

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const sourceDb = valueFor("--source-db");
if (sourceDb === undefined || sourceDb.trim() === "") {
  usage();
  console.error("Missing required --source-db");
  process.exit(1);
}

const generatedAt = new Date().toISOString().replaceAll(":", "-");
const workDb = valueFor("--work-db", join(tmpdir(), `quasar-sqlite-first-proof-${generatedAt}.sqlite`));
const outPath = valueFor("--out", `docs/proofs/sqlite-first-proof-${generatedAt}.json`)!;
const queries = args.flatMap((arg, index) => (arg === "--query" && args[index + 1] !== undefined ? [args[index + 1]!] : []));
const vectorLimit = numberFor("--vector-limit", 20_000);
const exactScanLimit = numberFor("--scan-limit", vectorLimit);

const report = runSqliteFirstProof({
  sourceDb: resolve(sourceDb),
  workDb: resolve(workDb!),
  profile: embeddingProfileFromEnv(),
  queries: queries.length > 0 ? queries : undefined,
  vectorLimit,
  exactScanLimit,
});

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, command: "sqlite-first-proof", outPath, workDb: report.workDb }, null, 2));
