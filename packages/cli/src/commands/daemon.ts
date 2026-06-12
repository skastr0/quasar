import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { configPath, quasarHome } from "../config";
import { CommandInputError } from "../errors";
import { executeJsonCommand } from "../output";

const LABEL = "com.guilhermecastro.quasar.ingest";
const DEFAULT_INTERVAL_SECONDS = 300;

const uid = (): string => {
  if (typeof process.getuid === "function") return String(process.getuid());
  const result = spawnSync("id", ["-u"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("id -u failed");
  return result.stdout.trim();
};

const launchDomain = () => `gui/${uid()}`;

const plistEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");

const defaultPath = (): string =>
  [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".local", "share", "mise", "installs", "bun", "latest", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");

export const daemonPaths = (env: NodeJS.ProcessEnv = process.env) => {
  const home = resolve(env.HOME ?? homedir());
  const stateHome = resolve(env.QUASAR_HOME ?? quasarHome());
  const logsDir = join(stateHome, "logs");
  return {
    home,
    stateHome,
    config: resolve(env.QUASAR_CONFIG ?? configPath()),
    logsDir,
    launchAgentPath: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    stdoutLog: join(logsDir, "ingest.out.log"),
    stderrLog: join(logsDir, "ingest.err.log"),
  };
};

const localQuasarBinary = () => join(homedir(), ".local", "bin", "quasar");

const currentSourceCommand = (): readonly string[] | undefined => {
  const entry = process.argv[1];
  if (entry === undefined || basename(entry) === basename(process.execPath)) return undefined;
  return entry.endsWith(".ts") ? [process.execPath, "run", resolve(entry)] : undefined;
};

const installedQuasarCommand = (binaryOverride?: string): readonly string[] | undefined => {
  if (binaryOverride !== undefined && binaryOverride.trim().length > 0) {
    return [resolve(binaryOverride)];
  }
  if (existsSync(localQuasarBinary())) return [localQuasarBinary()];
  const pathBinary = Bun.which("quasar");
  if (pathBinary !== null) return [pathBinary];
  return currentSourceCommand();
};

const commandXml = (command: readonly string[]) =>
  command
    .map((part) => `    <string>${plistEscape(part)}</string>`)
    .join("\n");

const envXml = (envVars: Record<string, string>) =>
  Object.entries(envVars)
    .map(([key, value]) => `    <key>${plistEscape(key)}</key>\n    <string>${plistEscape(value)}</string>`)
    .join("\n");

export const renderLaunchAgentPlist = (options: {
  readonly command: readonly string[];
  readonly intervalSeconds?: number;
  readonly env?: NodeJS.ProcessEnv;
}): string => {
  const env = options.env ?? process.env;
  const paths = daemonPaths(env);
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const envVars: Record<string, string> = {
    HOME: paths.home,
    PATH: env.QUASAR_DAEMON_PATH ?? defaultPath(),
    QUASAR_HOME: paths.stateHome,
    QUASAR_CONFIG: paths.config,
  };

  for (const key of [
    "CONVEX_URL",
    "CONVEX_SELF_HOSTED_URL",
    "QUASAR_USE_FALLBACK_URL",
  ] as const) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) envVars[key] = value;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${commandXml([...options.command, "ingest", "--provider", "all"])}
  </array>
  <key>WorkingDirectory</key>
  <string>${plistEscape(paths.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml(envVars)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${plistEscape(paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${plistEscape(paths.stderrLog)}</string>
</dict>
</plist>
`;
};

const checkedInterval = (value: Option.Option<number>): number => {
  const interval = Option.getOrElse(value, () => DEFAULT_INTERVAL_SECONDS);
  if (!Number.isInteger(interval) || interval < 60) {
    throw new CommandInputError({
      field: "interval-seconds",
      message: `interval-seconds must be an integer >= 60, got ${interval}`,
    });
  }
  return interval;
};

const runLaunchctl = (args: readonly string[]) =>
  spawnSync("launchctl", [...args], { encoding: "utf8" });

export const installLaunchAgent = (options: {
  readonly binary?: string;
  readonly intervalSeconds: number;
}) => {
  if (platform() !== "darwin") {
    throw new Error("LaunchAgent install is only supported on macOS");
  }
  const command = installedQuasarCommand(options.binary);
  if (command === undefined) {
    throw new Error("quasar binary not found; install the CLI or pass --binary <path>");
  }
  const paths = daemonPaths();
  mkdirSync(dirname(paths.launchAgentPath), { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(
    paths.launchAgentPath,
    renderLaunchAgentPlist({ command, intervalSeconds: options.intervalSeconds }),
    "utf8",
  );

  runLaunchctl(["bootout", launchDomain(), paths.launchAgentPath]);
  const bootstrap = runLaunchctl(["bootstrap", launchDomain(), paths.launchAgentPath]);
  if (bootstrap.status !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`);
  }
  const enable = runLaunchctl(["enable", `${launchDomain()}/${LABEL}`]);
  if (enable.status !== 0) {
    throw new Error(`launchctl enable failed: ${enable.stderr || enable.stdout}`);
  }
  const kickstart = runLaunchctl(["kickstart", "-k", `${launchDomain()}/${LABEL}`]);
  if (kickstart.status !== 0) {
    throw new Error(`launchctl kickstart failed: ${kickstart.stderr || kickstart.stdout}`);
  }
  return { action: "install", label: LABEL, plist: paths.launchAgentPath, intervalSeconds: options.intervalSeconds };
};

export const uninstallLaunchAgent = () => {
  const paths = daemonPaths();
  const bootout = platform() === "darwin" && existsSync(paths.launchAgentPath)
    ? runLaunchctl(["bootout", launchDomain(), paths.launchAgentPath])
    : undefined;
  rmSync(paths.launchAgentPath, { force: true });
  return {
    action: "uninstall",
    label: LABEL,
    plist: paths.launchAgentPath,
    bootoutStatus: bootout?.status ?? null,
  };
};

export const launchAgentStatus = () => {
  const paths = daemonPaths();
  const print = platform() === "darwin"
    ? runLaunchctl(["print", `${launchDomain()}/${LABEL}`])
    : undefined;
  return {
    label: LABEL,
    plist: paths.launchAgentPath,
    installed: existsSync(paths.launchAgentPath),
    loaded: print?.status === 0,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    logs: { stdout: paths.stdoutLog, stderr: paths.stderrLog },
  };
};

const binaryOption = Options.text("binary").pipe(
  Options.withDescription("Override the quasar binary used by launchd"),
  Options.optional,
);
const intervalOption = Options.integer("interval-seconds").pipe(
  Options.withDescription("LaunchAgent StartInterval in seconds (default 300; minimum 60)"),
  Options.optional,
);

const installCommand = Command.make(
  "install",
  { binary: binaryOption, intervalSeconds: intervalOption },
  ({ binary, intervalSeconds }) =>
    executeJsonCommand(
      "daemon install",
      Effect.try({
        try: () => installLaunchAgent({
          binary: Option.getOrUndefined(binary),
          intervalSeconds: checkedInterval(intervalSeconds),
        }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);

const uninstallCommand = Command.make("uninstall", {}, () =>
  executeJsonCommand("daemon uninstall", Effect.try({
    try: uninstallLaunchAgent,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })),
);

const statusCommand = Command.make("status", {}, () =>
  executeJsonCommand("daemon status", Effect.succeed(launchAgentStatus())),
);

export const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription("Install or inspect the macOS LaunchAgent for incremental ingest"),
  Command.withSubcommands([installCommand, uninstallCommand, statusCommand]),
);
