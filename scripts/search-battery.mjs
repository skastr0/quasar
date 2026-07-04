#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_SERVER = process.env.QUASAR_SERVER_URL ?? "http://127.0.0.1:7180";
const DEFAULT_OUT = `docs/proofs/search-battery-${new Date().toISOString().replaceAll(":", "-")}.json`;

const args = process.argv.slice(2);

const valueFor = (name, fallback) => {
  const index = args.lastIndexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};

const hasFlag = (name) => args.includes(name);

const numberFor = (name, fallback) => {
  const parsed = Number.parseInt(valueFor(name, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const server = valueFor("--server", DEFAULT_SERVER);
const limit = numberFor("--limit", 10);
const timeoutMs = numberFor("--timeout-ms", 60_000);
const repeats = numberFor("--repeats", 1);
const loadRepeats = numberFor("--load-repeats", 3);
const outPath = valueFor("--out", DEFAULT_OUT);
const modes = valueFor("--modes", "lexical,semantic,fusion").split(",").map((mode) => mode.trim()).filter(Boolean);
const concurrencies = valueFor("--concurrency", "1,2,4").split(",").map((value) => Number.parseInt(value, 10)).filter((value) => Number.isFinite(value) && value > 0);

const goldenQueries = [
  {
    id: "codex-legacy-header",
    category: "exact incident",
    query: "codex legacy header session_meta",
    expectedAny: ["legacy", "session_meta", "0.2.2", "fix(cli): support codex legacy session headers"],
  },
  {
    id: "orbstack-recovery",
    category: "operations",
    query: "orbstack quasar ingest disk queue",
    expectedAny: ["OrbStack", "quasar", "disk", "queue", "recovery"],
  },
  {
    id: "backpressure-embedding",
    category: "pipeline",
    query: "backpressure queue embeddings lancedb indexing scale",
    expectedAny: ["embed", "queue", "LanceDB", "index", "backpressure"],
  },
  {
    id: "maintain-worker",
    category: "worker semantics",
    query: "quasar maintain worker",
    expectedAny: ["worker", "maintenance", "WorkerSupervisorLive", "quasar maintain"],
  },
  {
    id: "readiness-listversions",
    category: "recent failure",
    query: "lancedb listVersions readiness search timeout",
    expectedAny: ["listVersions", "readiness", "tableStats", "timeout"],
  },
  {
    id: "business-intelligence",
    category: "concept recall",
    query: "agent sessions business intelligence corpus",
    expectedAny: ["business intelligence", "corpus", "sessions", "GOLD"],
  },
  {
    id: "claude-retention",
    category: "provider behavior",
    query: "Claude Code expires sessions 30 days",
    expectedAny: ["Claude", "30 days", "sessions older than 30 days", "deleted"],
  },
  {
    id: "tailscale-svc-route",
    category: "network route",
    query: "Tailscale svc quasar mac mini route 7180",
    expectedAny: ["svc:quasar", "7180", "Tailscale", "route"],
  },
  {
    id: "sqlite-lancedb-hot-path",
    category: "architecture regression",
    query: "SQLite LanceDB hot path readiness full scans countSearchableMessages",
    expectedAny: ["countSearchableMessages", "hot path", "full scans", "SQLite", "LanceDB"],
  },
  {
    id: "quasar-saas-architecture",
    category: "strategy",
    query: "Quasar SaaS per customer deploy Turso Railway multitenant",
    expectedAny: ["SaaS", "per customer", "Turso", "Railway", "multitenant"],
  },
  {
    id: "agent-adapters",
    category: "product surface",
    query: "customers build their own adapters for their own agents",
    expectedAny: ["adapters", "agents", "customers", "Quasar"],
  },
  {
    id: "tool-payloads",
    category: "indexing contract",
    query: "tool payloads should not pollute session search embeddings",
    expectedAny: ["tool", "payload", "embedding", "search"],
  },
  {
    id: "server-serving-proof",
    category: "ops / serving",
    query: "server agent serving proof",
    expectedAny: ["server", "serving", "proof", "status"],
  },
  {
    id: "production-proof",
    category: "ops / serving",
    query: "server production proof",
    expectedAny: ["server", "production", "proof", "status"],
  },
  {
    id: "readiness-503",
    category: "readiness / index health",
    query: "readiness gate stale index 503 wrong results",
    expectedAny: ["readiness", "503", "stale", "index"],
  },
  {
    id: "unindexed-tail",
    category: "readiness / index health",
    query: "search readiness fail closed unindexed tail",
    expectedAny: ["readiness", "fail closed", "unindexed", "tail"],
  },
  {
    id: "vector-text-index",
    category: "readiness / index health",
    query: "vector_idx text_idx maintenance optimize",
    expectedAny: ["vector_idx", "text_idx", "maintenance", "optimize"],
  },
  {
    id: "qsr-223",
    category: "readiness / index health",
    query: "QSR-223 search readiness",
    expectedAny: ["QSR-223", "search readiness", "readiness"],
  },
  {
    id: "embedding-dimension",
    category: "embeddings / profile",
    query: "embedding profile LanceDB messages table vector dimension mismatch",
    expectedAny: ["embedding", "LanceDB", "dimension", "profile"],
  },
  {
    id: "nomic-split-profile",
    category: "embeddings / profile",
    query: "nomic 768 split profile",
    expectedAny: ["nomic", "768", "split", "profile"],
  },
  {
    id: "embedding-cache",
    category: "embeddings / profile",
    query: "embedding cache pending 0 cached",
    expectedAny: ["embedding cache", "pending", "cached"],
  },
  {
    id: "unembedded-profile",
    category: "embeddings / profile",
    query: "unembedded contentHash profile table",
    expectedAny: ["unembedded", "contentHash", "profile", "table"],
  },
  {
    id: "tool-calls-structural",
    category: "tool-call boundary",
    query: "tool-calls structural retrieval surface",
    expectedAny: ["tool", "structural", "retrieval", "surface"],
  },
  {
    id: "toolcalls-table",
    category: "tool-call boundary",
    query: "toolCalls table",
    expectedAny: ["toolCalls", "table"],
  },
  {
    id: "row-grain",
    category: "row-grain / contract",
    query: "row grain messages sessions tool calls",
    expectedAny: ["row", "messages", "sessions", "tool"],
  },
  {
    id: "redaction-boundary",
    category: "row-grain / contract",
    query: "redactSensitive provider garbage boundary",
    expectedAny: ["redactSensitive", "provider garbage", "boundary"],
  },
  {
    id: "incremental-sync",
    category: "recent workflow / proof threads",
    query: "incremental sync server",
    expectedAny: ["incremental", "sync", "server"],
  },
  {
    id: "qsr-117",
    category: "recent workflow / proof threads",
    query: "QSR-117 incremental local-server sync",
    expectedAny: ["QSR-117", "incremental", "local-server", "sync"],
  },
  {
    id: "retrieval-proof",
    category: "recent workflow / proof threads",
    query: "embedding retrieval comparison proof",
    expectedAny: ["embedding", "retrieval", "comparison", "proof"],
  },
  {
    id: "route-filters",
    category: "route / filter sanity",
    query: "projectKey role provider limit search fusion",
    expectedAny: ["projectKey", "role", "provider", "limit", "fusion"],
  },
  {
    id: "mode-names",
    category: "route / filter sanity",
    query: "search lexical semantic fusion",
    expectedAny: ["lexical", "semantic", "fusion"],
  },
];

const usage = () => {
  console.log(`Usage:
  bun scripts/search-battery.mjs [--server URL] [--limit 10] [--modes lexical,semantic,fusion] [--repeats 1] [--concurrency 1,2,4] [--load-repeats 3] [--timeout-ms 60000] [--out path.json] [--ops]

Read-only. Runs fixed golden search probes plus bounded load probes against a running Quasar server.
Set QUASAR_SEARCH_PROFILE=1 on the server to include per-request receipts in the JSON output.
`);
};

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
};

const summarizeLatency = (values) => ({
  count: values.length,
  minMs: Math.min(...values),
  p50Ms: percentile(values, 50),
  p95Ms: percentile(values, 95),
  p99Ms: percentile(values, 99),
  maxMs: Math.max(...values),
});

const snippet = (value, length = 260) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, length) : "";

const requestJson = async (path, params = {}) => {
  const url = new URL(path, server.endsWith("/") ? server : `${server}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const completedAt = new Date().toISOString();
  const elapsedMs = Math.round(performance.now() - started);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, error: { type: "NonJsonResponse", message: text.slice(0, 500) } };
  }
  return { ok: response.ok && body?.ok !== false, http: response.status, startedAt, completedAt, elapsedMs, body };
};

const receiptFrom = (body) => body?.data?.receipt ?? null;

const summarizeHit = (hit) => {
  const row = hit?.row ?? {};
  return {
    score: hit?.score,
    key: hit?.key ?? row.key,
    sessionId: row.sessionId,
    projectKey: row.projectKey,
    role: row.role,
    seq: row.seq,
    text: snippet(row.text),
  };
};

const expectedRank = (matches, expectedAny) => {
  const terms = expectedAny.map((term) => term.toLowerCase());
  for (let index = 0; index < matches.length; index += 1) {
    const text = JSON.stringify(matches[index]).toLowerCase();
    if (terms.some((term) => text.includes(term))) return index + 1;
  }
  return null;
};

const shellSnapshot = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (error) {
    return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
};

const opsSnapshot = async (label) => {
  const [ready, status] = await Promise.allSettled([
    requestJson("/ready"),
    requestJson("/status"),
  ]);
  const statusData = status.status === "fulfilled" ? status.value.body?.data ?? {} : {};
  return {
    label,
    capturedAt: new Date().toISOString(),
    ready: ready.status === "fulfilled" ? {
      ok: ready.value.ok,
      http: ready.value.http,
      startedAt: ready.value.startedAt,
      completedAt: ready.value.completedAt,
      elapsedMs: ready.value.elapsedMs,
      data: ready.value.body?.data,
    } : { ok: false, error: String(ready.reason) },
    status: status.status === "fulfilled" ? {
      ok: status.value.ok,
      http: status.value.http,
      startedAt: status.value.startedAt,
      completedAt: status.value.completedAt,
      elapsedMs: status.value.elapsedMs,
      data: statusData,
    } : { ok: false, error: String(status.reason) },
    dockerStats: hasFlag("--ops")
      ? shellSnapshot("docker", ["stats", "--no-stream", "--format", "{{json .}}", "quasar-server-server-1"])
      : undefined,
    disk: hasFlag("--ops")
      ? shellSnapshot("df", ["-h", "/System/Volumes/Data"])
      : undefined,
    recentServerErrors: hasFlag("--ops")
      ? shellSnapshot("sh", ["-lc", "docker logs --since=5m quasar-server-server-1 2>&1 | rg ' 499| 5[0-9][0-9]|ERROR|WARN' | tail -40"])
      : undefined,
  };
};

const runGolden = async () => {
  const cases = [];
  for (const item of goldenQueries) {
    for (const mode of modes) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const response = await requestJson(`/search/${mode}`, { q: item.query, limit });
        const matches = response.body?.data?.matches ?? [];
        const summarized = Array.isArray(matches) ? matches.map(summarizeHit) : [];
        const rank = expectedRank(summarized, item.expectedAny);
        const receipt = receiptFrom(response.body);
        cases.push({
          queryLabel: item.id,
          category: item.category,
          query: item.query,
          mode,
          repeat,
          ok: response.ok,
          http: response.http,
          statusCode: response.http,
          startedAt: response.startedAt,
          completedAt: response.completedAt,
          elapsedMs: response.elapsedMs,
          receipt,
          matchCount: summarized.length,
          expectedRank: rank,
          hitAt1: rank !== null && rank <= 1,
          hitAt3: rank !== null && rank <= 3,
          hitAt10: rank !== null && rank <= 10,
          top: summarized[0] ?? null,
          error: response.ok ? undefined : response.body?.error,
        });
      }
    }
  }
  return cases;
};

const pooled = async (tasks, concurrency) => {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
};

const runLoad = async () => {
  const loadQueries = goldenQueries.slice(0, 6);
  const byConcurrency = [];
  for (const concurrency of concurrencies) {
    const tasks = [];
    for (let repeat = 0; repeat < loadRepeats; repeat += 1) {
      for (const item of loadQueries) {
        for (const mode of modes) {
          tasks.push(async () => {
            try {
              const response = await requestJson(`/search/${mode}`, { q: item.query, limit: 3 });
              const receipt = receiptFrom(response.body);
              return {
                queryLabel: item.id,
                mode,
                ok: response.ok,
                http: response.http,
                statusCode: response.http,
                startedAt: response.startedAt,
                completedAt: response.completedAt,
                elapsedMs: response.elapsedMs,
                receipt,
                matchCount: response.body?.data?.matches?.length ?? 0,
                error: response.ok ? undefined : response.body?.error,
              };
            } catch (error) {
              return {
                queryLabel: item.id,
                mode,
                ok: false,
                http: 0,
                statusCode: 0,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                elapsedMs: timeoutMs,
                receipt: null,
                matchCount: 0,
                error: { message: error instanceof Error ? error.message : String(error) },
              };
            }
          });
        }
      }
    }
    const before = await opsSnapshot(`before concurrency ${concurrency}`);
    const started = performance.now();
    const results = await pooled(tasks, concurrency);
    const elapsedMs = Math.round(performance.now() - started);
    const after = await opsSnapshot(`after concurrency ${concurrency}`);
    const failures = results.filter((result) => !result.ok || result.http >= 500);
    byConcurrency.push({
      concurrency,
      elapsedMs,
      total: results.length,
      failures: failures.length,
      latency: summarizeLatency(results.map((result) => result.elapsedMs)),
      byMode: Object.fromEntries(modes.map((mode) => {
        const modeResults = results.filter((result) => result.mode === mode);
        return [mode, {
          total: modeResults.length,
          failures: modeResults.filter((result) => !result.ok || result.http >= 500).length,
          latency: summarizeLatency(modeResults.map((result) => result.elapsedMs)),
        }];
      })),
      before,
      after,
      samples: results.slice(0, 10),
    });
    if (failures.length > 0 || percentile(results.map((result) => result.elapsedMs), 95) > 30_000) break;
  }
  return byConcurrency;
};

const aggregateGolden = (cases) => {
  const byMode = Object.fromEntries(modes.map((mode) => {
    const modeCases = cases.filter((entry) => entry.mode === mode);
    const latencies = modeCases.map((entry) => entry.elapsedMs);
    return [mode, {
      total: modeCases.length,
      ok: modeCases.filter((entry) => entry.ok).length,
      hitAt1: modeCases.filter((entry) => entry.hitAt1).length,
      hitAt3: modeCases.filter((entry) => entry.hitAt3).length,
      hitAt10: modeCases.filter((entry) => entry.hitAt10).length,
      misses: modeCases.filter((entry) => entry.expectedRank === null).map((entry) => entry.queryLabel),
      latency: summarizeLatency(latencies),
    }];
  }));
  return { byMode };
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const initialOps = await opsSnapshot("initial");
  const golden = await runGolden();
  const load = hasFlag("--skip-load") ? [] : await runLoad();
  const finalOps = await opsSnapshot("final");
  const report = {
    ok: golden.every((entry) => entry.ok)
      && load.every((entry) => entry.failures === 0)
      && initialOps.ready.ok
      && finalOps.ready.ok
      && initialOps.status.ok
      && finalOps.status.ok,
    startedAt,
    completedAt: new Date().toISOString(),
    server,
    limit,
    modes,
    repeats,
    loadRepeats,
    concurrencies,
    timeoutMs,
    queryCount: goldenQueries.length,
    aggregate: aggregateGolden(golden),
    initialOps,
    finalOps,
    golden,
    load,
  };
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: report.ok,
    outPath,
    aggregate: report.aggregate,
    load: report.load.map((entry) => ({
      concurrency: entry.concurrency,
      total: entry.total,
      failures: entry.failures,
      latency: entry.latency,
      byMode: entry.byMode,
    })),
    initialReadyMs: report.initialOps.ready.elapsedMs,
    finalReadyMs: report.finalOps.ready.elapsedMs,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
