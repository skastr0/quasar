#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { LanceDb } from "@skastr0/quasar-search";
import { Effect } from "effect";

import { ingest, ingestRemote } from "./ingest";
import type { IngestReport } from "./ingest";
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

const daemonLabel = "com.quasar.remote-ingest";
const daemonHome = () => resolve(process.env.QUASAR_DAEMON_HOME ?? join(homedir(), ".config", "quasar"));
const daemonPaths = () => {
  const home = daemonHome();
  return {
    home,
    logs: join(home, "logs"),
    lock: join(home, "remote-ingest.lock"),
    lockInfo: join(home, "remote-ingest.lock", "info.json"),
    plist: join(homedir(), "Library", "LaunchAgents", `${daemonLabel}.plist`),
    stdout: join(home, "logs", "remote-ingest.out.log"),
    stderr: join(home, "logs", "remote-ingest.err.log"),
  };
};

const launchDomain = () => `gui/${typeof process.getuid === "function" ? process.getuid() : spawnText("id", ["-u"])}`;

const xml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const daemonBinary = () => arg("--binary") ?? process.env.QUASAR_DAEMON_BINARY ?? process.execPath;

const daemonInterval = () => {
  const raw = arg("--interval-seconds") ?? process.env.QUASAR_DAEMON_INTERVAL_SECONDS ?? "60";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 60) {
    throw new Error(`--interval-seconds must be an integer >= 60, got ${raw}`);
  }
  return parsed;
};

const daemonToken = () => arg("--ingest-token") ?? process.env.QUASAR_INGEST_TOKEN;

const daemonPlist = (options: { readonly binary: string; readonly serverUrl: string; readonly ingestToken: string; readonly intervalSeconds: number }) => {
  const paths = daemonPaths();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${daemonLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.binary)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
    <key>PATH</key>
    <string>${xml(`${dirname(options.binary)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
    <key>QUASAR_DAEMON_BINARY</key>
    <string>${xml(options.binary)}</string>
    <key>QUASAR_LOCAL_SERVER_URL</key>
    <string>${xml(options.serverUrl)}</string>
    <key>QUASAR_INGEST_TOKEN</key>
    <string>${xml(options.ingestToken)}</string>
    <key>QUASAR_DAEMON_HOME</key>
    <string>${xml(paths.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${options.intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderr)}</string>
</dict>
</plist>
`;
};

const installDaemon = () => {
  if (platform() !== "darwin") throw new Error("daemon install is only supported on macOS launchd");
  const serverUrl = server();
  if (serverUrl === undefined) throw new Error("--server or QUASAR_LOCAL_SERVER_URL is required");
  const ingestToken = daemonToken();
  if (ingestToken === undefined) throw new Error("--ingest-token or QUASAR_INGEST_TOKEN is required");
  const binary = resolve(daemonBinary());
  const intervalSeconds = daemonInterval();
  const paths = daemonPaths();
  mkdirSync(dirname(paths.plist), { recursive: true });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  writeFileSync(paths.plist, daemonPlist({ binary, serverUrl, ingestToken, intervalSeconds }), { encoding: "utf8", mode: 0o600 });
  spawnSync("launchctl", ["bootout", launchDomain(), paths.plist], { stdio: "ignore" });
  runLaunchctl(["bootstrap", launchDomain(), paths.plist]);
  runLaunchctl(["enable", `${launchDomain()}/${daemonLabel}`]);
  runLaunchctl(["kickstart", "-k", `${launchDomain()}/${daemonLabel}`]);
  return { label: daemonLabel, plist: paths.plist, intervalSeconds, serverUrl, lock: paths.lock, logs: { stdout: paths.stdout, stderr: paths.stderr } };
};

const uninstallDaemon = () => {
  const paths = daemonPaths();
  if (platform() === "darwin") spawnSync("launchctl", ["bootout", launchDomain(), paths.plist], { stdio: "ignore" });
  if (existsSync(paths.plist)) unlinkSync(paths.plist);
  return { label: daemonLabel, plist: paths.plist, installed: false };
};

const daemonStatus = () => {
  const paths = daemonPaths();
  const result = platform() === "darwin" ? spawnSync("launchctl", ["print", `${launchDomain()}/${daemonLabel}`], { encoding: "utf8" }) : undefined;
  return {
    label: daemonLabel,
    plist: paths.plist,
    installed: existsSync(paths.plist),
    loaded: result?.status === 0,
    lock: { path: paths.lock, held: existsSync(paths.lock) },
    logs: { stdout: paths.stdout, stderr: paths.stderr },
    output: result?.status === 0 ? result.stdout : result?.stderr,
  };
};

const runDaemonTick = () => {
  const paths = daemonPaths();
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  if (!acquireDaemonLock(paths)) {
    writeJson(ok("daemon run", { skipped: true, reason: "already_running", lock: paths.lock }));
    return;
  }
  const cleanup = () => rmSync(paths.lock, { recursive: true, force: true });
  process.once("exit", cleanup);
  process.once("SIGINT", () => { cleanup(); process.exit(130); });
  process.once("SIGTERM", () => { cleanup(); process.exit(143); });

  const binary = process.env.QUASAR_DAEMON_BINARY ?? process.execPath;
  const serverUrl = server();
  const ingestToken = daemonToken();
  if (serverUrl === undefined || ingestToken === undefined) {
    cleanup();
    throw new Error("daemon run requires QUASAR_LOCAL_SERVER_URL and QUASAR_INGEST_TOKEN");
  }
  const result = spawnSync(binary, ["ingest", "--provider", "all", "--summary", "--server", serverUrl, "--ingest-token", ingestToken], {
    stdio: "inherit",
    env: process.env,
  });
  cleanup();
  process.exit(result.status ?? (result.signal === null ? 1 : 128));
};

const acquireDaemonLock = (paths: ReturnType<typeof daemonPaths>) => {
  try {
    mkdirSync(paths.lock);
    writeFileSync(paths.lockInfo, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return true;
  } catch {
    if (!daemonLockIsStale(paths)) return false;
    rmSync(paths.lock, { recursive: true, force: true });
    try {
      mkdirSync(paths.lock);
      writeFileSync(paths.lockInfo, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), recoveredStaleLock: true }, null, 2), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
};

const daemonLockIsStale = (paths: ReturnType<typeof daemonPaths>) => {
  const staleSeconds = Number(process.env.QUASAR_DAEMON_STALE_LOCK_SECONDS ?? "3600");
  try {
    const info = JSON.parse(readFileSync(paths.lockInfo, "utf8")) as { startedAt?: unknown };
    if (typeof info.startedAt !== "string") return false;
    const startedAt = Date.parse(info.startedAt);
    return Number.isFinite(startedAt) && Date.now() - startedAt > staleSeconds * 1000;
  } catch {
    return false;
  }
};

const runLaunchctl = (args: readonly string[]) => {
  const result = spawnSync("launchctl", [...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`launchctl ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
};

const spawnText = (command: string, args: readonly string[]) => {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
};

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

const summarizeIngestReports = (reports: readonly IngestReport[]) => ({
  reports: reports.map((report) => ({
    provider: report.provider,
    sessionsSeen: report.sessionsSeen,
    sessionsWritten: report.sessionsWritten,
    sessionsSkipped: report.sessionsSkipped,
    sessionsFailed: report.sessionsFailed,
    messagesWritten: report.messagesWritten,
    toolCallsWritten: report.toolCallsWritten,
    jobsEnqueued: report.jobsEnqueued,
    searchDocuments: report.searchDocuments,
    failures: report.failures,
    durationMs: report.durationMs,
  })),
});

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
  case "daemon": {
    const subcommand = process.argv[3] ?? "status";
    try {
      if (subcommand === "install") writeJson(ok("daemon install", installDaemon()));
      else if (subcommand === "uninstall") writeJson(ok("daemon uninstall", uninstallDaemon()));
      else if (subcommand === "status") writeJson(ok("daemon status", daemonStatus()));
      else if (subcommand === "run") runDaemonTick();
      else throw new Error(`unknown daemon subcommand: ${subcommand}`);
    } catch (error) {
      writeJson(fail(`daemon ${subcommand}`, error));
      process.exitCode = 1;
    }
    break;
  }
  case "ingest": {
    const options = {
      provider: (arg("--provider") ?? "all") as never,
      limit: arg("--limit") === undefined ? undefined : intArg("--limit", 1),
      force: flag("--force"),
      ingestToken: arg("--ingest-token") ?? process.env.QUASAR_INGEST_TOKEN,
    };
    const base = server();
    if (base !== undefined) {
      try {
        const reports = await ingestRemote(options, base);
        writeJson(ok("ingest", flag("--summary") ? summarizeIngestReports(reports) : reports));
      } catch (error) {
        writeJson(fail("ingest", error));
        process.exitCode = 1;
      }
      break;
    }
    const program = ingest(options).pipe(
      Effect.map((reports) => flag("--summary") ? summarizeIngestReports(reports) : reports),
    );
    await run("ingest", program);
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
      provider: arg("--provider"),
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
          provider: arg("--provider"),
          toolName: arg("--tool-name"),
          limit: intArg("--limit", 100),
          offset: intArg("--offset", 0),
        });
        return { rows };
      }),
    );
    break;
  }
  case "tool-call": {
    const id = arg("--id");
    if (id === undefined) {
      writeJson(fail("tool-call", new Error("--id is required")));
      process.exitCode = 1;
      break;
    }
    if (await fetchServer("tool-call", "/tool-call", { id })) break;
    await run(
      "tool-call",
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const row = yield* store.getToolCall(id);
        if (row === undefined) throw new Error(`tool call not found: ${id}`);
        return { row };
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
    if (await fetchServer("search", `/search/${mode}`, { q: query, limit: arg("--limit"), projectKey: arg("--project-key"), role: arg("--role") })) break;
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
          role: arg("--role"),
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
          "ingest --provider all|claude|codex|opencode|hermes|grok [--limit n] [--force] [--summary]",
          "ingest --provider all --server http://<mac-mini-tailscale-ip>:6180",
          "daemon install --server http://<mac-mini-tailscale-ip>:6180 --ingest-token <token> [--interval-seconds 60]",
          "daemon status",
          "daemon uninstall",
          "serve [--host 127.0.0.1] [--port 6180]",
          "projects [--limit n] [--offset n]",
          "sessions [--provider name] [--project-key key] [--limit n] [--offset n]",
          "messages --session-id id [--limit n]",
          "tool-calls [--session-id id] [--project-key key] [--provider name] [--tool-name name] [--limit n] [--offset n]",
          "tool-call --id id",
          "ingest-runs [--status running|completed|failed] [--limit n]",
          "maintain [--vector true|false] [--optimize true|false] [--server url]",
          "freshness [--limit n] [--server url]",
          "repair-index [--limit n] [--lease-ms n] [--server url]",
          "workers [--server url]",
          "worker-tick",
          "embed-batch [--limit n] [--lease-ms n] [--worker-id id]",
          "recover-leases [--now iso]",
          "search --query text [--mode lexical|semantic|fusion] [--project-key key] [--role user|assistant] [--limit n] [--server url]",
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
          QUASAR_INGEST_TOKEN: "required for remote write ingest and daemon install/run",
        },
      }),
    );
}
