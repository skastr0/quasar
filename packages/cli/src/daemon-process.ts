import { homedir } from "node:os";
import { dirname } from "node:path";

import { AMP_INGEST_ENV, GROK_INGEST_ENV } from "./adapters/registry";

export const daemonIngestProcess = (
  serverUrl: string,
  ingestToken: string,
  environment: NodeJS.ProcessEnv = process.env,
) => ({
  args: ["ingest", "--provider", "all", "--summary", "--server", serverUrl],
  env: {
    ...environment,
    QUASAR_INGEST_TOKEN: ingestToken,
  },
});

const xml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

export type DaemonPlistOptions = {
  readonly label: string;
  readonly binary: string;
  readonly serverUrl: string;
  readonly ingestToken: string;
  readonly intervalSeconds: number;
  readonly home: string;
  readonly stdout: string;
  readonly stderr: string;
  /** Poll Amp's servers from this machine. Off unless the installer said `--amp`. */
  readonly ampIngest: boolean;
  /**
   * Hold Grok out of `--provider all` after restart. Off unless the installer
   * said `--hold-grok`. Explicit `ingest --provider grok` is unchanged.
   */
  readonly holdGrok: boolean;
};

/** launchd plist for the ingest tick. Amp opt-in travels as an environment switch. */
export const daemonPlist = (options: DaemonPlistOptions) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${options.label}</string>
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
    <string>${xml(options.home)}</string>${options.ampIngest ? `
    <key>${AMP_INGEST_ENV}</key>
    <string>on</string>` : ""}${options.holdGrok ? `
    <key>${GROK_INGEST_ENV}</key>
    <string>off</string>` : ""}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${options.intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${xml(options.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.stderr)}</string>
</dict>
</plist>
`;

/** Whether an installed plist enables Amp ingest. */
export const plistEnablesAmpIngest = (plist: string): boolean =>
  new RegExp(`<key>${AMP_INGEST_ENV}</key>\\s*<string>on</string>`).test(plist);

/** Whether an installed plist holds Grok out of `--provider all`. */
export const plistHoldsGrok = (plist: string): boolean =>
  new RegExp(`<key>${GROK_INGEST_ENV}</key>\\s*<string>off</string>`).test(plist);
