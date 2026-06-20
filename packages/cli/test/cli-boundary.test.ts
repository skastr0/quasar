import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const packageRoot = join(import.meta.dir, "..");

const runCli = async (args: readonly string[], env: Record<string, string> = {}) => {
  const home = mkdtempSync(join(tmpdir(), "quasar-cli-home-"));
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: packageRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: tmpdir(),
      QUASAR_CONFIG: join(home, "missing-config.json"),
      QUASAR_LOCAL_SQLITE: join(home, "quasar.sqlite"),
      QUASAR_SEARCH_DATA_DIR: join(home, "search.lance"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stderr,
    stdout,
    json: JSON.parse(stdout) as {
      readonly ok: boolean;
      readonly command: string;
      readonly error?: {
        readonly type: string;
        readonly message: string;
        readonly details?: {
          readonly configPath?: string;
          readonly acceptedEnv?: readonly string[];
          readonly acceptedConfigFields?: readonly string[];
        };
      };
      readonly data?: unknown;
    },
  };
};

describe("CLI client/operator boundary", () => {
  test("client commands fail closed when no server URL is configured", async () => {
    const result = await runCli(["stats"]);

    expect(result.exitCode).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.command).toBe("stats");
    expect(result.json.error?.type).toBe("ConfigurationError");
    expect(result.json.error?.details?.acceptedEnv).toEqual(["QUASAR_LOCAL_SERVER_URL"]);
    expect(result.json.error?.details?.acceptedConfigFields).toEqual(["localServerUrl"]);
  });

  test("search does not fall back to embedded lexical search", async () => {
    const result = await runCli(["search", "--query", "effect server", "--mode", "lexical"]);

    expect(result.exitCode).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.command).toBe("search");
    expect(result.json.error?.type).toBe("ConfigurationError");
  });

  test("operator commands remain explicit and do not require a server URL", async () => {
    const result = await runCli(["operator-workers"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.command).toBe("operator-workers");
  });
});
