#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { QuerySpec } from "@skastr0/quasar-protocol";

import { parseCliArguments } from "./argv";
import { configuredIngestToken, configuredServerUrl, defaultClientConfigPath } from "./client-config";
import { Provider } from "./core/schemas";
import { ingestFailureError, ingestReportPayload } from "./ingest-report";
import { ingestRemote } from "./ingest";
import { fail, ok, writeJson } from "./json";
import {
  protocolContract,
  protocolExampleList,
  readQueryArgument,
  runQuery,
} from "./query-client";
import {
  messagesQuery,
  searchQuery,
  sessionsQuery,
  toolCallsQuery,
  type CommonQueryFilters,
  type QueryProjectionOptions,
} from "./query-spec";
import {
  addMaterializeTotals,
  decideMaterializeLoop,
  emptyMaterializeTotals,
  materializeClosureReceipt,
  materializeProviders,
  parseMaterializeBatch,
  requireMaterializeProvider,
  type MaterializeProvider,
  type MaterializeTotals,
} from "./materialize-receipt";

const valueOptionNames = new Set([
  "--agent",
  "--agent-name",
  "--agent-role",
  "--artifact-limit",
  "--binary",
  "--context-limit",
  "--cursor",
  "--edge-limit",
  "--event-limit",
  "--fields",
  "--id",
  "--ingest-token",
  "--interval-seconds",
  "--limit",
  "--max-batches",
  "--message-limit",
  "--mode",
  "--model",
  "--model-provider",
  "--name",
  "--offset",
  "--out",
  "--project",
  "--project-key",
  "--provider",
  "--providers",
  "--query",
  "--require-provider",
  "--role",
  "--schema",
  "--server",
  "--session",
  "--session-id",
  "--smoke-query",
  "--status",
  "--timeout-ms",
  "--tool",
  "--tool-call",
  "--tool-call-id",
  "--tool-call-limit",
  "--tool-name",
  "--usage-limit",
  "-q",
]);
const parsedArguments = parseCliArguments(process.argv.slice(2), valueOptionNames);
const arg = (name: string): string | undefined => parsedArguments.first(name);
const flag = (name: string): boolean => parsedArguments.has(name);
const args = (...names: readonly string[]): readonly string[] => parsedArguments.all(...names);

const firstArg = (...names: readonly string[]): string | undefined =>
  args(...names)[0];

const listArg = (...names: readonly string[]): readonly string[] | undefined => {
  const values = args(...names).flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return values.length === 0 ? undefined : values;
};

const intArg = (name: string, fallback: number): number => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const positiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const rawCommand = parsedArguments.positionals[0];
const isInteractiveTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const subcommandHelpTarget =
  rawCommand !== undefined && (flag("--help") || flag("-h"))
    ? rawCommand
    : undefined;
const command =
  subcommandHelpTarget !== undefined ? "help"
  : rawCommand === undefined && (flag("--help") || flag("-h")) ? "help"
  : rawCommand === undefined && (flag("--version") || flag("-v")) ? "version"
  : rawCommand === undefined && isInteractiveTty ? "tui"
  : rawCommand === undefined ? "help"
  : rawCommand;
const cliPackage = {
  name: "@skastr0/quasar-cli",
  version: "0.4.0",
};

const server = (): string | undefined => arg("--server") ?? configuredServerUrl();

type ConfigurationRequirement = "server" | "ingestToken";

class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
  readonly details: unknown;

  constructor(commandName: string, requirement: ConfigurationRequirement) {
    const details =
      requirement === "server"
        ? {
            configPath: defaultClientConfigPath(),
            acceptedEnv: ["QUASAR_SERVER_URL"],
            acceptedConfigFields: ["serverUrl"],
            examples: [
              "quasar <command> --server http://127.0.0.1:7180",
              "export QUASAR_SERVER_URL=http://127.0.0.1:7180",
              `write {"serverUrl":"http://127.0.0.1:7180"} to ${defaultClientConfigPath()}`,
            ],
          }
        : {
            configPath: defaultClientConfigPath(),
            acceptedEnv: ["QUASAR_INGEST_TOKEN"],
            acceptedConfigFields: ["ingestToken"],
            examples: [
              "quasar ingest --ingest-token <token>",
              "export QUASAR_INGEST_TOKEN=<token>",
              `write {"ingestToken":"<token>"} to ${defaultClientConfigPath()}`,
            ],
          };
    super(requirement === "server"
      ? `quasar ${commandName} requires a configured local server URL`
      : `quasar ${commandName} requires a configured ingest token`);
    this.details = details;
  }
}

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
  const raw = arg("--interval-seconds") ?? process.env.QUASAR_DAEMON_INTERVAL_SECONDS ?? "15";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 10) {
    throw new Error(`--interval-seconds must be an integer >= 10, got ${raw}`);
  }
  return parsed;
};

const daemonToken = () => arg("--ingest-token") ?? configuredIngestToken();

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
    <key>QUASAR_SERVER_URL</key>
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
  if (serverUrl === undefined) throw new Error("--server or QUASAR_SERVER_URL is required");
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
  const loaded = result?.status === 0;
  // launchctl print dumps the daemon's EnvironmentVariables block, which holds
  // QUASAR_INGEST_TOKEN. Never surface that raw output; derive only run-state.
  const running = loaded ? /\bstate\s*=\s*running\b/.test(result?.stdout ?? "") : false;
  return {
    label: daemonLabel,
    plist: paths.plist,
    installed: existsSync(paths.plist),
    loaded,
    running,
    lock: { path: paths.lock, held: existsSync(paths.lock) },
    logs: { stdout: paths.stdout, stderr: paths.stderr },
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
    throw new Error("daemon run requires QUASAR_SERVER_URL and QUASAR_INGEST_TOKEN");
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

const httpTimeoutMs = () => positiveInt(arg("--timeout-ms") ?? process.env.QUASAR_HTTP_TIMEOUT_MS, 60_000);

const isTransientFetchError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /socket|closed|ECONNRESET|ETIMEDOUT|terminated/i.test(message);
};

const fetchWithRetry = async (url: URL): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(httpTimeoutMs()) });
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || attempt === 2) break;
      await Bun.sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
};

const requireServer = (name: string): string | undefined => {
  const base = server();
  if (base !== undefined) return base;
  writeJson(fail(name, new ConfigurationError(name, "server")));
  process.exitCode = 2;
  return undefined;
};

const requireIngestToken = (name: string): string | undefined => {
  const token = arg("--ingest-token") ?? configuredIngestToken();
  if (token !== undefined) return token;
  writeJson(fail(name, new ConfigurationError(name, "ingestToken")));
  process.exitCode = 2;
  return undefined;
};

const fetchServerJson = async (name: string, path: string, params: Record<string, string | undefined> = {}) => {
  const base = requireServer(name);
  if (base === undefined) return;
  try {
    const response = await fetchWithRetry(urlFor(base, path, params));
    const body = await response.json();
    if (!response.ok) process.exitCode = 1;
    return body;
  } catch (error) {
    process.exitCode = 1;
    return fail(name, error);
  }
};

const fetchServer = async (name: string, path: string, params: Record<string, string | undefined> = {}) => {
  const body = await fetchServerJson(name, path, params);
  if (body !== undefined) writeJson(body);
};

class CommandInputError extends Error {
  override readonly name = "CommandInputError";
  readonly details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

const rejectInput = (name: string, error: unknown): false => {
  writeJson(fail(name, error));
  process.exitCode = 1;
  return false;
};

const checkEnum = (name: string, flag: string, allowed: readonly string[]): boolean => {
  const value = arg(flag);
  if (value === undefined || allowed.includes(value)) return true;
  return rejectInput(name, new CommandInputError(`${flag} must be one of: ${allowed.join(", ")}`, {
    path: flag,
    expected: allowed,
    received: value,
    hint: `Pass one of: ${allowed.join(", ")}.`,
  }));
};

const checkInt = (name: string, flag: string, min: number): boolean => {
  const raw = arg(flag);
  if (raw === undefined) return true;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= min) return true;
  return rejectInput(name, new CommandInputError(`${flag} must be an integer >= ${min}`, {
    path: flag,
    expected: `integer >= ${min}`,
    received: raw,
    hint: `Pass a whole number >= ${min}.`,
  }));
};

const checkIntRange = (name: string, flagName: string, min: number, max: number): boolean => {
  const raw = arg(flagName);
  if (raw === undefined) return true;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= min && parsed <= max) return true;
  return rejectInput(name, new CommandInputError(`${flagName} must be an integer from ${min} to ${max}`, {
    path: flagName,
    expected: `integer ${min}..${max}`,
    received: raw,
  }));
};

const SEARCH_MODES = ["lexical", "semantic", "fusion"] as const;
const INGEST_RUN_STATUSES = ["running", "completed", "failed"] as const;
const PROVIDERS = Provider.literals;
const INGEST_PROVIDERS = ["all", ...PROVIDERS] as const;
const QUERY_ROLES = ["user", "assistant", "reasoning"] as const;

const providersArg = (name: string): readonly string[] | undefined => {
  const providers = listArg("--provider", "--providers");
  if (providers === undefined) return undefined;
  const invalid = providers.find((provider) => !PROVIDERS.includes(provider as never));
  if (invalid !== undefined) {
    rejectInput(name, new CommandInputError(`--provider must be one of: ${PROVIDERS.join(", ")}`, {
      path: "--provider",
      expected: PROVIDERS,
      received: invalid,
    }));
    return undefined;
  }
  return providers;
};

const queryFilters = (name: string): CommonQueryFilters | undefined => {
  const providers = providersArg(name);
  if (process.exitCode === 1) return undefined;
  return {
    projectKey: firstArg("--project", "--project-key"),
    providers,
    sessionId: firstArg("--session", "--session-id"),
    role: arg("--role"),
    agentName: firstArg("--agent", "--agent-name"),
    agentRole: arg("--agent-role"),
    model: arg("--model"),
    modelProvider: arg("--model-provider"),
    toolCallId: firstArg("--tool-call", "--tool-call-id"),
    toolName: firstArg("--tool", "--tool-name"),
  };
};

const queryProjection = (): QueryProjectionOptions => ({
  detail: flag("--detail") ? "detail" : "summary",
  fields: listArg("--fields"),
  limit: arg("--limit") === undefined ? undefined : Number(arg("--limit")),
  cursor: arg("--cursor"),
});

const rejectQueryOffset = (name: string): boolean => {
  if (!flag("--offset")) return true;
  const offset = arg("--offset");
  return rejectInput(name, new CommandInputError("--offset was removed from query-backed commands", {
    path: "--offset",
    received: offset ?? null,
    expected: "opaque --cursor token from page.nextCursor",
    hint: "Pass the previous response's page.nextCursor as --cursor.",
  }));
};

const executeQuery = async (name: string, build: () => QuerySpec) => {
  let spec: QuerySpec;
  try {
    spec = build();
  } catch (error) {
    rejectInput(name, error);
    return;
  }
  const base = requireServer(name);
  if (base === undefined) return;
  try {
    const response = await runQuery(spec, {
      serverUrl: base,
      timeoutMs: httpTimeoutMs(),
    });
    writeJson(response);
  } catch (error) {
    writeJson(fail(name, error));
    process.exitCode = 1;
  }
};

const materializeFailureDetails = (details: unknown, batches: number, totals: MaterializeTotals, last: unknown) => ({
  ...(typeof details === "object" && details !== null ? details as Record<string, unknown> : {}),
  batches,
  totals,
  last,
});

const writeJsonAndMaybeOut = (value: unknown): void => {
  const outPath = arg("--out");
  if (outPath !== undefined && outPath.trim() !== "") {
    const resolved = resolve(outPath);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  }
  writeJson(value);
};

const parseMaterializeProviderRequirement = (name: string): MaterializeProvider | undefined => {
  const raw = arg("--require-provider");
  if (raw === undefined) return undefined;
  if ((materializeProviders as readonly string[]).includes(raw)) return raw as MaterializeProvider;
  rejectInput(name, new CommandInputError("--require-provider must be local or synthetic", {
    path: "--require-provider",
    expected: materializeProviders.join("|"),
    received: raw,
    hint: "Use --require-provider local for the local ONNX materialization receipt gate.",
  }));
  return undefined;
};

const materializeEmbeddingVectorsUntilEmpty = async (requiredProvider: MaterializeProvider | undefined) => {
  const name = "materialize-embedding-vectors";
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const maxBatches = intArg("--max-batches", 100_000);
  const totals = emptyMaterializeTotals();
  let batches = 0;
  let lastData: unknown;
  while (batches < maxBatches) {
    const body = await fetchServerJson(name, "/maintenance/embeddings/materialize-sqlite", {
      limit: arg("--limit"),
    });
    if (body === undefined) return;
    const parsed = parseMaterializeBatch(body);
    if (!parsed.ok) {
      writeJson(fail(name, parsed.error));
      process.exitCode = 1;
      return;
    }
    const providerError = requireMaterializeProvider(parsed.receipt, requiredProvider);
    if (providerError !== undefined) {
      writeJson(fail(name, new CommandInputError(
        providerError.message,
        materializeFailureDetails(providerError.details, batches, totals, lastData),
      )));
      process.exitCode = 1;
      return;
    }
    addMaterializeTotals(totals, parsed.receipt.counters);
    batches += 1;
    lastData = parsed.receipt.data;
    const decision = decideMaterializeLoop(parsed.receipt);
    if (decision.kind === "success") {
      writeJsonAndMaybeOut(ok(name, {
        mode: "until-empty",
        startedAt,
        finishedAt: new Date().toISOString(),
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
        batches,
        totals,
        closure: materializeClosureReceipt(parsed.receipt),
        last: lastData,
      }));
      return;
    }
    if (decision.kind === "failure") {
      writeJson(fail(name, new CommandInputError(
        decision.error.message,
        materializeFailureDetails(decision.error.details, batches, totals, lastData),
      )));
      process.exitCode = 1;
      return;
    }
  }
  writeJson(fail(name, new CommandInputError("--max-batches exhausted before coverage reached zero", {
    path: "--max-batches",
    expected: "enough batches to reach vectorlessMessages = 0",
    received: String(maxBatches),
    hint: "Increase --max-batches or inspect the last response for stuck coverage.",
    batches,
    totals,
    last: lastData,
  })));
  process.exitCode = 1;
};

const materializeEmbeddingVectors = async () => {
  const name = "materialize-embedding-vectors";
  if (!(checkInt(name, "--limit", 1) && checkInt(name, "--max-batches", 1))) return;
  const requiredProvider = parseMaterializeProviderRequirement(name);
  if (process.exitCode !== undefined) return;
  if (arg("--out") !== undefined && !flag("--until-empty")) {
    rejectInput(name, new CommandInputError("--out requires --until-empty", {
      path: "--out",
      expected: "use --out only with the complete materialization loop",
      hint: "Run materialize-embedding-vectors --until-empty --out <path> for a durable closure receipt.",
    }));
    return;
  }
  if (requiredProvider !== undefined && !flag("--until-empty")) {
    rejectInput(name, new CommandInputError("--require-provider requires --until-empty", {
      path: "--require-provider",
      expected: "use --require-provider only with the parsed materialization loop",
      hint: "Run materialize-embedding-vectors --until-empty --require-provider local.",
    }));
    return;
  }
  if (flag("--until-empty")) {
    await materializeEmbeddingVectorsUntilEmpty(requiredProvider);
  } else {
    await fetchServer(name, "/maintenance/embeddings/materialize-sqlite", { limit: arg("--limit") });
  }
};

const missingValueOption = parsedArguments.missingValueOptions[0];
if (missingValueOption !== undefined) {
  rejectInput(command, new CommandInputError(`${missingValueOption} requires a value`, {
    path: missingValueOption,
    expected: `a value following ${missingValueOption}`,
    received: null,
    hint: `Pass ${missingValueOption} <value>.`,
  }));
} else switch (command) {
  case "daemon": {
    const subcommand = parsedArguments.positionals[1] ?? "status";
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
    if (!(checkEnum("ingest", "--provider", INGEST_PROVIDERS) && checkInt("ingest", "--limit", 1))) break;
    const base = requireServer("ingest");
    if (base === undefined) break;
    const ingestToken = requireIngestToken("ingest");
    if (ingestToken === undefined) break;
    const options = {
      provider: (arg("--provider") ?? "all") as never,
      limit: arg("--limit") === undefined ? undefined : intArg("--limit", 1),
      force: flag("--force"),
      ingestToken,
      timeoutMs: httpTimeoutMs(),
    };
    try {
      const reports = await ingestRemote(options, base);
      const failure = ingestFailureError(reports);
      if (failure !== undefined) throw failure;
      writeJson(ok("ingest", ingestReportPayload(reports, flag("--summary"))));
    } catch (error) {
      writeJson(fail("ingest", error));
      process.exitCode = 1;
    }
    break;
  }
  case "stats": {
    await fetchServer("stats", "/status");
    break;
  }
  case "projects": {
    if (!(checkInt("projects", "--limit", 1) && checkInt("projects", "--offset", 0))) break;
    await fetchServer("projects", "/projects", { limit: arg("--limit"), offset: arg("--offset") });
    break;
  }
  case "sessions": {
    if (!(rejectQueryOffset("sessions") && checkIntRange("sessions", "--limit", 1, 200))) break;
    const filters = queryFilters("sessions");
    if (filters === undefined) break;
    await executeQuery("sessions", () => sessionsQuery({ filters, projection: queryProjection() }));
    break;
  }
  case "messages": {
    const sessionId = firstArg("--session", "--session-id");
    if (sessionId === undefined) {
      rejectInput("messages", new CommandInputError("--session-id is required", {
        field: "--session-id",
        expected: "a session id",
        hint: "Pass --session-id <id> (find ids via `quasar sessions`).",
      }));
      break;
    }
    if (!(rejectQueryOffset("messages") && checkEnum("messages", "--role", QUERY_ROLES) && checkIntRange("messages", "--limit", 1, 200))) break;
    const filters = queryFilters("messages");
    if (filters === undefined) break;
    await executeQuery("messages", () => messagesQuery({ sessionId, filters, projection: queryProjection() }));
    break;
  }
  case "tool-calls": {
    if (!(rejectQueryOffset("tool-calls") && checkIntRange("tool-calls", "--limit", 1, 200))) break;
    const filters = queryFilters("tool-calls");
    if (filters === undefined) break;
    await executeQuery("tool-calls", () => toolCallsQuery({ filters, projection: queryProjection() }));
    break;
  }
  case "tool-call": {
    const id = arg("--id") ?? firstArg("--tool-call", "--tool-call-id");
    if (id === undefined) {
      rejectInput("tool-call", new CommandInputError("--id is required", {
        field: "--id",
        expected: "a tool-call id",
        hint: "Pass --id <id> (find ids via `quasar tool-calls`).",
      }));
      break;
    }
    const filters = queryFilters("tool-call");
    if (filters === undefined) break;
    await executeQuery("tool-call", () => toolCallsQuery({
      filters: { ...filters, toolCallId: id },
      projection: { ...queryProjection(), detail: "detail", limit: 1 },
    }));
    break;
  }
  case "session": {
    const id = arg("--id") ?? firstArg("--session", "--session-id");
    if (id === undefined) {
      rejectInput("session", new CommandInputError("--id is required", {
        field: "--id",
        expected: "a session id",
        hint: "Pass --id <id> (find ids via `quasar sessions`).",
      }));
      break;
    }
    const detailLimitFlags = [
      "--message-limit", "--tool-call-limit", "--event-limit", "--usage-limit",
      "--edge-limit", "--artifact-limit", "--context-limit",
    ] as const;
    if (!detailLimitFlags.every((flagName) => checkIntRange("session", flagName, 1, 1_000))) break;
    await fetchServer("session", "/session-detail", {
      sessionId: id,
      messageLimit: arg("--message-limit"),
      toolCallLimit: arg("--tool-call-limit"),
      eventLimit: arg("--event-limit"),
      usageLimit: arg("--usage-limit"),
      edgeLimit: arg("--edge-limit"),
      artifactLimit: arg("--artifact-limit"),
      contextLimit: arg("--context-limit"),
    });
    break;
  }
  case "ingest-runs": {
    if (!(checkEnum("ingest-runs", "--status", INGEST_RUN_STATUSES) && checkInt("ingest-runs", "--limit", 1) && checkInt("ingest-runs", "--offset", 0))) break;
    await fetchServer("ingest-runs", "/ingest-runs", { status: arg("--status"), limit: arg("--limit"), offset: arg("--offset") });
    break;
  }
  case "replay-embedding-cache": {
    if (!checkInt("replay-embedding-cache", "--limit", 1)) break;
    await fetchServer("replay-embedding-cache", "/maintenance/embeddings/replay-cache", { limit: arg("--limit") });
    break;
  }
  case "materialize-embedding-vectors": {
    await materializeEmbeddingVectors();
    break;
  }
  case "prune-dead-letters": {
    await fetchServer("prune-dead-letters", "/maintenance/queue/prune-resolved-failures");
    break;
  }
  case "workers": {
    await fetchServer("workers", "/status");
    break;
  }
  case "search": {
    if (!(rejectQueryOffset("search") && checkEnum("search", "--mode", SEARCH_MODES) && checkEnum("search", "--role", QUERY_ROLES) && checkIntRange("search", "--limit", 1, 200))) break;
    const query = arg("--query") ?? arg("-q") ?? "";
    const mode = arg("--mode") ?? "lexical";
    const filters = queryFilters("search");
    if (filters === undefined) break;
    await executeQuery("search", () => searchQuery({ text: query, mode, filters, projection: queryProjection() }));
    break;
  }
  case "query": {
    const source = parsedArguments.positionals[1];
    await executeQuery("query", () => readQueryArgument(source));
    break;
  }
  case "schema": {
    try {
      const requested = arg("--name") ?? parsedArguments.positionals[1];
      writeJson(ok("schema", protocolContract(requested)));
    } catch (error) {
      rejectInput("schema", error);
    }
    break;
  }
  case "examples": {
    try {
      writeJson(ok("examples", protocolExampleList(arg("--name") ?? arg("--schema") ?? parsedArguments.positionals[1])));
    } catch (error) {
      rejectInput("examples", error);
    }
    break;
  }
  case "tui": {
    const { launchTui } = await import("./tui/entry");
    const exit = await launchTui({ smoke: flag("--smoke"), smokeQuery: arg("--smoke-query"), server: server() });
    if (exit?.editorFile !== undefined) {
      // $EDITOR may carry args, e.g. "code --wait" or "subl --wait".
      const parts = (exit.editor ?? "vi").trim().split(/\s+/);
      spawnSync(parts[0]!, [...parts.slice(1), exit.editorFile], { stdio: "inherit" });
    }
    break;
  }
  case "version": {
    writeJson(ok("version", cliPackage));
    break;
  }
  case "help": {
    const commands = [
      "ingest --provider all|codex|claude|opencode|grok|kimi|hermes|antigravity|omp|pi|cursor|devin [--server url] [--limit n] [--force] [--summary]",
      "daemon install --server https://<quasar-service-tailnet-hostname> --ingest-token <token> [--interval-seconds 60]",
      "daemon status",
      "daemon uninstall",
      "projects [--limit n] [--offset n]",
      "sessions [--provider name[,name]] [--project key] [--agent name] [--agent-role role] [--model slug] [--model-provider name] [--fields a,b] [--detail] [--cursor token] [--limit n]",
      "session --id id [--message-limit n] [--tool-call-limit n] [--event-limit n] [--usage-limit n] [--edge-limit n] [--artifact-limit n] [--context-limit n]",
      "messages --session id [--role user|assistant|reasoning] [--model slug] [--model-provider name] [--fields a,b] [--detail] [--cursor token] [--limit n]",
      "tool-calls [--session id] [--project key] [--provider name[,name]] [--tool name] [--agent name] [--agent-role role] [--model slug] [--model-provider name] [--fields a,b] [--detail] [--cursor token] [--limit n]",
      "tool-call --id id [--fields a,b] (full input/output detail)",
      "query <inline-json|@file|-> [--server url]",
      "schema [query|response|session-enrichment] (local; no server required)",
      "examples [schema-id|example-name] (local; no server required)",
      "ingest-runs [--status running|completed|failed] [--limit n]",
      "replay-embedding-cache [--limit n] [--server url]",
      "materialize-embedding-vectors [--limit n] [--until-empty] [--max-batches n] [--require-provider local|synthetic] [--out path] [--server url]",
      "prune-dead-letters [--server url] (delete failed queue jobs whose work is provably done, orphaned, or a retired kind)",
      "workers [--server url]",
      "search --query text [--mode lexical|semantic|fusion] [--project key] [--provider name[,name]] [--role user|assistant|reasoning] [--agent name] [--agent-role role] [--model slug] [--model-provider name] [--fields a,b] [--detail] [--cursor token] [--limit n] [--server url]",
      "stats",
      "tui [--server url] (interactive terminal UI; default when run in a terminal)",
      "version",
    ];
    writeJson(
      ok("help", {
        ...(subcommandHelpTarget !== undefined ? { target: subcommandHelpTarget } : {}),
        commands: subcommandHelpTarget === undefined
          ? commands
          : commands.filter((entry) => entry === subcommandHelpTarget || entry.startsWith(`${subcommandHelpTarget} `)),
        env: {
          QUASAR_LOCAL_HOME: "override ~/.config/quasar/server",
          QUASAR_CONFIG: "override ~/.config/quasar/config.json for default server/token routing",
          QUASAR_LOCAL_SQLITE: "override SQLite file path",
          QUASAR_CODEX_ROOT: "override Codex history root",
          QUASAR_CLAUDE_ROOT: "override Claude history root",
          QUASAR_OPENCODE_ROOT: "override OpenCode history root",
          QUASAR_GROK_ROOT: "override Grok history root",
          QUASAR_HERMES_ROOT: "override Hermes history root",
          QUASAR_KIMI_ROOT: "override Kimi history root",
          QUASAR_ANTIGRAVITY_ROOT: "override Antigravity history root",
          QUASAR_OMP_ROOT: "override OMP history root",
          QUASAR_PI_ROOT: "override Pi history root",
          QUASAR_CURSOR_ROOT: "override Cursor Agent history root",
          QUASAR_DEVIN_ROOT: "override Devin history root",
          QUASAR_SERVER_URL: "route client commands through an already-running local server",
          QUASAR_INGEST_TOKEN: "required for remote write ingest and daemon install/run unless config has ingestToken",
          QUASAR_HTTP_TIMEOUT_MS: "client HTTP timeout for server requests, default 60000",
        },
      }),
    );
    break;
  }
  default:
    rejectInput(command, new CommandInputError(`unknown command: ${command}`, {
      received: command,
      expected: "a known command",
      hint: "Run `quasar help` for the command list.",
    }));
}
