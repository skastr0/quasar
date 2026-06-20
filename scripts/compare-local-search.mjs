#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_SERVER = process.env.QUASAR_LOCAL_SERVER_URL ?? "http://127.0.0.1:6180";
const DEFAULT_LIMIT = 5;

const querySet = [
  {
    id: "project-retrieval",
    category: "project/session retrieval",
    query: "Quasar local server Effect architecture SQLite LanceDB Docker Tailscale",
    intent: "Find sessions about the Effect local-server architecture.",
  },
  {
    id: "code-debug",
    category: "code/debug text",
    query: "embedding profile LanceDB messages table vector dimension mismatch",
    intent: "Find sessions/debug work about mixed embedding dimensions and LanceDB table routing.",
  },
  {
    id: "json-transcripts",
    category: "JSON-ish transcripts",
    query: "tool call payload messages search surface JSON dump should not be embedded",
    intent: "Find prior reasoning about keeping tool payloads out of semantic message search.",
  },
  {
    id: "decision-memory",
    category: "decision-memory recall",
    query: "measured data contract store at turn grain indexing separate decision",
    intent: "Find the durable architecture rulings that shaped Quasar's data model.",
  },
  {
    id: "operations",
    category: "operations proof",
    query: "Mac mini Tailscale IP Docker local server full corpus ingest proof",
    intent: "Find operational proof sessions about Mac mini deployment and full ingest readiness.",
  },
];

const args = process.argv.slice(2);

const valuesFor = (name) => {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]);
  }
  return values;
};

const valueFor = (name, fallback) => valuesFor(name).at(-1) ?? fallback;
const hasFlag = (name) => args.includes(name);

const limit = Number.parseInt(valueFor("--limit", String(DEFAULT_LIMIT)), 10);
const modes = (valueFor("--modes", "lexical,semantic,fusion") ?? "")
  .split(",")
  .map((mode) => mode.trim())
  .filter(Boolean);

const parseProfile = (raw) => {
  const separator = raw.indexOf("=");
  if (separator === -1) return { name: raw, url: raw };
  return { name: raw.slice(0, separator), url: raw.slice(separator + 1) };
};

const profiles = valuesFor("--profile").map(parseProfile);
if (profiles.length === 0) {
  profiles.push({ name: valueFor("--name", "active"), url: valueFor("--server", DEFAULT_SERVER) });
}

const outPath = valueFor("--out", `docs/proofs/embedding-retrieval-comparison-${new Date().toISOString().slice(0, 10)}.md`);
const jsonPath = valueFor("--json", outPath.replace(/\.md$/, ".json"));

const usage = () => {
  console.log(`Usage:
  bun scripts/compare-local-search.mjs [--server URL] [--name active] [--profile name=URL ...] [--limit 5] [--modes lexical,semantic,fusion] [--out path.md] [--json path.json]

Examples:
  QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180 bun scripts/compare-local-search.mjs --name active
  bun scripts/compare-local-search.mjs --profile gemini=http://<mac-mini-tailscale-ip>:6180 --profile nomic=http://<mac-mini-tailscale-ip>:6181
`);
};

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const requestJson = async (base, path, params = {}) => {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const startedAt = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, error: { type: "NonJsonResponse", message: text.slice(0, 500) } };
  }
  return { ok: response.ok && body?.ok !== false, status: response.status, elapsedMs, body };
};

const summarizeHit = (hit) => {
  const row = hit?.row ?? {};
  const text = typeof row.text === "string" ? row.text : "";
  return {
    key: hit?.key ?? row.key,
    score: hit?.score,
    sessionId: row.sessionId,
    projectKey: row.projectKey,
    role: row.role,
    seq: row.seq,
    text: text.replace(/\s+/g, " ").slice(0, 240),
  };
};

const run = async () => {
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    limit,
    modes,
    querySet,
    profiles: [],
  };

  for (const profile of profiles) {
    const status = await requestJson(profile.url, "/status");
    const profileReport = {
      name: profile.name,
      url: profile.url,
      status,
      queries: [],
    };

    for (const item of querySet) {
      const queryReport = { ...item, modes: {} };
      for (const mode of modes) {
        const response = await requestJson(profile.url, `/search/${mode}`, { q: item.query, limit });
        const matches = response.body?.data?.matches ?? [];
        queryReport.modes[mode] = {
          ok: response.ok,
          status: response.status,
          elapsedMs: response.elapsedMs,
          error: response.ok ? undefined : response.body?.error,
          matches: Array.isArray(matches) ? matches.map(summarizeHit) : [],
        };
      }
      profileReport.queries.push(queryReport);
    }

    report.profiles.push(profileReport);
  }

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  mkdirSync(dirname(resolve(jsonPath)), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(outPath, renderMarkdown(report, jsonPath));
  console.log(JSON.stringify({ ok: true, outPath, jsonPath, profiles: profiles.map((profile) => profile.name) }, null, 2));
};

const eitherRight = (either) => either?._tag === "Right" ? either.right : undefined;

const renderStatus = (status) => {
  const data = status.body?.data ?? {};
  const sqlite = eitherRight(data.sqlite);
  const lance = eitherRight(data.lance);
  return [
    `- HTTP: ${status.ok ? "ok" : "failed"} (${status.status}, ${status.elapsedMs}ms)`,
    `- SQLite: ${sqlite ? `${sqlite.sessions} sessions, ${sqlite.messages} messages, ${sqlite.toolCalls} tool calls` : "unavailable"}`,
    `- LanceDB: ${lance ? `${lance.tableName} ${lance.rowCount} rows, ${lance.indices?.map((index) => index.name).join(", ") || "no indexes"}` : "unavailable"}`,
    `- Embedding cache: ${data.embeddings ? `${data.embeddings.cached} cached, ${data.embeddings.pending} pending` : "unavailable"}`,
    `- Queue: ${data.queue ? `${data.queue.pending} pending, ${data.queue.leased} leased, ${data.queue.failed} failed` : "unavailable"}`,
  ].join("\n");
};

const renderMarkdown = (report, jsonArtifact) => {
  const lines = [
    `# Embedding retrieval comparison proof — ${report.generatedAt.slice(0, 10)}`,
    "",
    "This proof compares Quasar retrieval behavior on fixed real agent-session queries. It is intentionally HTTP-level: each named profile points at a running local-server instance, so Gemini and Nomic can be compared without changing the script or mixing vector spaces.",
    "",
    "Gemini spend is bounded to query embeddings for this fixed query set when a Gemini-profile server is included. Corpus embedding is not triggered by this script; server-side query embedding cache should make repeated runs no-op for already-seen query text.",
    "",
    `JSON artifact: \`${jsonArtifact}\``,
    "",
    "## Query set",
    "",
    "| id | category | query | intent |",
    "| --- | --- | --- | --- |",
    ...report.querySet.map((item) => `| ${item.id} | ${item.category} | ${item.query.replaceAll("|", "\\|")} | ${item.intent.replaceAll("|", "\\|")} |`),
    "",
  ];

  for (const profile of report.profiles) {
    lines.push(`## Profile: ${profile.name}`, "", `Server: \`${profile.url}\``, "", renderStatus(profile.status), "");
    for (const query of profile.queries) {
      lines.push(`### ${query.id} — ${query.category}`, "", `Query: \`${query.query}\``, "", `Intent: ${query.intent}`, "");
      for (const mode of Object.keys(query.modes)) {
        const result = query.modes[mode];
        lines.push(`#### ${mode}`, "", `Status: ${result.ok ? "ok" : "failed"} (${result.status}, ${result.elapsedMs}ms)`, "");
        if (!result.ok) {
          lines.push(`Error: \`${JSON.stringify(result.error)}\``, "");
          continue;
        }
        if (result.matches.length === 0) {
          lines.push("No matches.", "");
          continue;
        }
        lines.push("| rank | score | project | session | role/seq | snippet |", "| ---: | ---: | --- | --- | --- | --- |");
        result.matches.forEach((hit, index) => {
          lines.push(`| ${index + 1} | ${typeof hit.score === "number" ? hit.score.toFixed(4) : ""} | ${hit.projectKey ?? ""} | ${hit.sessionId ?? ""} | ${hit.role ?? ""}/${hit.seq ?? ""} | ${(hit.text ?? "").replaceAll("|", "\\|")} |`);
        });
        lines.push("");
      }
    }
  }

  lines.push("## Interpretation checklist", "", "- Mark Nomic as acceptable only if it retrieves the same session families or better on project/session, code/debug, JSON-ish transcript, and decision-memory queries.", "- Prefer fusion for operator use when lexical/code snippets matter; semantic-only is a recall aid, not the sole retrieval surface.", "- Re-run this proof with both `gemini=<url>` and `nomic=<url>` profiles before changing the production default for a larger estate.", "");
  return `${lines.join("\n")}\n`;
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
