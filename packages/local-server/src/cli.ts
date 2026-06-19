#!/usr/bin/env bun
import { LanceDb } from "@skastr0/quasar-search";
import { Effect } from "effect";

import { ingest } from "./ingest";
import { fail, ok, writeJson } from "./json";
import { SearchMaintenance } from "./maintenance";
import { AppRuntime } from "./runtime";
import { DerivedSearch } from "./search";
import { serve } from "./server";
import { DurableQueue, Embeddings, WorkerSupervisor } from "./services";
import { LocalStore } from "./store";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const flag = (name: string): boolean => process.argv.includes(name);

const intArg = (name: string, fallback: number): number => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const command = process.argv[2] ?? "help";

const server = (): string | undefined => arg("--server") ?? process.env.QUASAR_LOCAL_SERVER_URL;

const urlFor = (base: string, path: string, params: Record<string, string | undefined>) => {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value.trim() !== "") url.searchParams.set(key, value);
  }
  return url;
};

const fetchServer = async (name: string, path: string, params: Record<string, string | undefined> = {}) => {
  const base = server();
  if (base === undefined) return false;
  try {
    const response = await fetch(urlFor(base, path, params));
    writeJson(await response.json());
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    writeJson(fail(name, error));
    process.exitCode = 1;
  }
  return true;
};

const run = async (name: string, program: Effect.Effect<unknown, unknown, LocalStore | LanceDb | DurableQueue | DerivedSearch | SearchMaintenance | WorkerSupervisor | Embeddings>) => {
  try {
    writeJson(ok(name, await AppRuntime.runPromise(program)));
  } catch (error) {
    writeJson(fail(name, error));
    process.exitCode = 1;
  } finally {
    await AppRuntime.dispose();
  }
};

switch (command) {
  case "ingest": {
    await run(
      "ingest",
      ingest({
        provider: (arg("--provider") ?? "all") as never,
        limit: arg("--limit") === undefined ? undefined : intArg("--limit", 1),
        force: flag("--force"),
      }),
    );
    break;
  }
  case "serve": {
    serve({ port: intArg("--port", 6180), hostname: arg("--host") ?? process.env.QUASAR_LOCAL_HOST ?? "127.0.0.1" });
    break;
  }
  case "stats": {
    if (await fetchServer("stats", "/status")) break;
    await run(
      "stats",
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const search = yield* LanceDb;
        const [sqlite, lance] = yield* Effect.all([
          store.stats.pipe(Effect.either),
          search.tableStats({}).pipe(Effect.either),
        ]);
        return { sqlite, lance };
      }),
    );
    break;
  }
  case "projects": {
    if (await fetchServer("projects", "/projects", { limit: arg("--limit"), offset: arg("--offset") })) break;
    await run(
      "projects",
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const rows = yield* store.listProjects({ limit: intArg("--limit", 100), offset: intArg("--offset", 0) });
        return { rows };
      }),
    );
    break;
  }
  case "sessions": {
    if (await fetchServer("sessions", "/sessions", {
      provider: arg("--provider"),
      projectKey: arg("--project-key"),
      limit: arg("--limit"),
      offset: arg("--offset"),
    })) break;
    await run(
      "sessions",
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const rows = yield* store.listSessions({
          provider: arg("--provider"),
          projectKey: arg("--project-key"),
          limit: intArg("--limit", 100),
          offset: intArg("--offset", 0),
        });
        return { rows };
      }),
    );
    break;
  }
  case "messages": {
    const sessionId = arg("--session-id");
    if (sessionId === undefined) {
      writeJson(fail("messages", new Error("--session-id is required")));
      process.exitCode = 1;
      break;
    }
    if (await fetchServer("messages", "/messages", { sessionId, limit: arg("--limit") })) break;
    await run(
      "messages",
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const rows = yield* store.readMessages(sessionId, intArg("--limit", 1000));
        return { sessionId, rows };
      }),
    );
    break;
  }
  case "tool-calls": {
    if (await fetchServer("tool-calls", "/tool-calls", {
      sessionId: arg("--session-id"),
      projectKey: arg("--project-key"),
      toolName: arg("--tool-name"),
      limit: arg("--limit"),
      offset: arg("--offset"),
    })) break;
    await run(
      "tool-calls",
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const rows = yield* store.listToolCalls({
          sessionId: arg("--session-id"),
          projectKey: arg("--project-key"),
          toolName: arg("--tool-name"),
          limit: intArg("--limit", 100),
          offset: intArg("--offset", 0),
        });
        return { rows };
      }),
    );
    break;
  }
  case "ingest-runs": {
    if (await fetchServer("ingest-runs", "/ingest-runs", { status: arg("--status"), limit: arg("--limit"), offset: arg("--offset") })) break;
    await run(
      "ingest-runs",
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const rows = yield* store.listIngestRuns({
          status: arg("--status") as never,
          limit: intArg("--limit", 100),
          offset: intArg("--offset", 0),
        });
        return { rows };
      }),
    );
    break;
  }
  case "maintain": {
    if (await fetchServer("maintain", "/maintenance/run", { vector: arg("--vector"), optimize: arg("--optimize") })) break;
    await run(
      "maintain",
      Effect.gen(function* () {
        const maintenance = yield* SearchMaintenance;
        return yield* maintenance.maintain({
          includeVector: arg("--vector") !== "false",
          optimize: arg("--optimize") !== "false",
        });
      }),
    );
    break;
  }
  case "freshness": {
    if (await fetchServer("freshness", "/maintenance/freshness", { limit: arg("--limit") })) break;
    await run(
      "freshness",
      Effect.gen(function* () {
        const maintenance = yield* SearchMaintenance;
        return yield* maintenance.reconcileFreshness({ limit: intArg("--limit", 500) });
      }),
    );
    break;
  }
  case "repair-index": {
    if (await fetchServer("repair-index", "/maintenance/repair", { limit: arg("--limit"), leaseMs: arg("--lease-ms") })) break;
    await run(
      "repair-index",
      Effect.gen(function* () {
        const maintenance = yield* SearchMaintenance;
        return yield* maintenance.repairOnce({
          workerId: "cli-maintenance",
          limit: intArg("--limit", 100),
          leaseMs: intArg("--lease-ms", 60_000),
        });
      }),
    );
    break;
  }
  case "workers": {
    if (await fetchServer("workers", "/status")) break;
    await run(
      "workers",
      Effect.gen(function* () {
        const workers = yield* WorkerSupervisor;
        return yield* workers.status;
      }),
    );
    break;
  }
  case "worker-tick": {
    await run(
      "worker-tick",
      Effect.gen(function* () {
        const workers = yield* WorkerSupervisor;
        return yield* workers.tickOnce;
      }),
    );
    break;
  }
  case "embed-batch": {
    await run(
      "embed-batch",
      Effect.gen(function* () {
        const embeddings = yield* Embeddings;
        return yield* embeddings.processBatch({
          workerId: arg("--worker-id") ?? "cli-embedding-worker",
          limit: intArg("--limit", 32),
          leaseMs: intArg("--lease-ms", 60_000),
        });
      }),
    );
    break;
  }
  case "recover-leases": {
    await run(
      "recover-leases",
      Effect.gen(function* () {
        const queue = yield* DurableQueue;
        const recovered = yield* queue.recoverStaleLeases(arg("--now"));
        const stats = yield* queue.statsByKind;
        return { recovered, byKind: stats };
      }),
    );
    break;
  }
  case "search": {
    const query = arg("--query") ?? arg("-q") ?? "";
    const mode = arg("--mode") ?? "lexical";
    if (await fetchServer("search", `/search/${mode}`, { q: query, limit: arg("--limit"), projectKey: arg("--project-key") })) break;
    if (mode !== "lexical") {
      writeJson(fail("search", new Error("local CLI semantic/fusion search requires --server")));
      process.exitCode = 1;
      break;
    }
    await run(
      "search",
      Effect.gen(function* () {
        const search = yield* DerivedSearch;
        const matches = yield* search.lexicalSearch({
          query,
          projectKey: arg("--project-key"),
          limit: intArg("--limit", 10),
        });
        return { matches };
      }),
    );
    break;
  }
  case "help":
  default:
    writeJson(
      ok("help", {
        commands: [
          "ingest --provider all|claude|codex|opencode|hermes|grok [--limit n] [--force]",
          "serve [--host 127.0.0.1] [--port 6180]",
          "projects [--limit n] [--offset n]",
          "sessions [--provider name] [--project-key key] [--limit n] [--offset n]",
          "messages --session-id id [--limit n]",
          "tool-calls [--session-id id] [--project-key key] [--tool-name name] [--limit n]",
          "ingest-runs [--status running|completed|failed] [--limit n]",
          "maintain [--vector true|false] [--optimize true|false] [--server url]",
          "freshness [--limit n] [--server url]",
          "repair-index [--limit n] [--lease-ms n] [--server url]",
          "workers [--server url]",
          "worker-tick",
          "embed-batch [--limit n] [--lease-ms n] [--worker-id id]",
          "recover-leases [--now iso]",
          "search --query text [--mode lexical|semantic|fusion] [--project-key key] [--limit n] [--server url]",
          "stats",
        ],
        env: {
          QUASAR_LOCAL_HOME: "override ~/.config/quasar/local-server",
          QUASAR_LOCAL_SQLITE: "override SQLite file path",
          QUASAR_SEARCH_DATA_DIR: "override LanceDB directory",
          QUASAR_CODEX_ROOT: "override Codex history root",
          QUASAR_CLAUDE_ROOT: "override Claude history root",
          QUASAR_OPENCODE_ROOT: "override OpenCode history root",
          QUASAR_GROK_ROOT: "override Grok history root",
          QUASAR_HERMES_ROOT: "override Hermes history root",
          QUASAR_KIMI_ROOT: "override Kimi history root",
          QUASAR_ANTIGRAVITY_ROOT: "override Antigravity history root",
          QUASAR_LOCAL_SERVER_URL: "route read/search commands through an already-running local server",
        },
      }),
    );
}
