import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";

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
  test("help aliases are explicit", async () => {
    for (const alias of [["--help"], ["-h"]] as const) {
      const result = await runCli(alias);

      expect(result.exitCode).toBe(0);
      expect(result.json.ok).toBe(true);
      expect(result.json.command).toBe("help");
      expect(result.stdout.split("\n")).toHaveLength(2);
    }
  }, 15_000);

  test("subcommand help is local and scoped", async () => {
    const result = await runCli(["search", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.command).toBe("help");
    expect(result.json.data).toEqual(expect.objectContaining({
      target: "search",
      commands: [expect.stringContaining("search --query")],
    }));
  }, 15_000);

  test("version aliases report package metadata", async () => {
    for (const alias of [["--version"], ["-v"], ["version"]] as const) {
      const result = await runCli(alias);

      expect(result.exitCode).toBe(0);
      expect(result.json.ok).toBe(true);
      expect(result.json.command).toBe("version");
      expect(result.json.data).toEqual({
        name: packageJson.name,
        version: packageJson.version,
      });
    }
  }, 15_000);

  test("client commands fail closed when no server URL is configured", async () => {
    const result = await runCli(["stats"]);

    expect(result.exitCode).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.command).toBe("stats");
    expect(result.json.error?.type).toBe("ConfigurationError");
    expect(result.json.error?.details?.acceptedEnv).toEqual(["QUASAR_SERVER_URL"]);
    expect(result.json.error?.details?.acceptedConfigFields).toEqual(["serverUrl"]);
  }, 15_000);

  test("search does not fall back to embedded lexical search", async () => {
    const result = await runCli(["search", "--query", "effect server", "--mode", "lexical"]);

    expect(result.exitCode).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.command).toBe("search");
    expect(result.json.error?.type).toBe("ConfigurationError");
  }, 15_000);

  test("search validates and forwards provider scope", async () => {
    let requestedUrl: URL | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requestedUrl = new URL(request.url);
        return Response.json({ ok: true, command: "search/lexical", data: { matches: [] } });
      },
    });
    try {
      const result = await runCli([
        "search",
        "--query",
        "effect server",
        "--mode",
        "lexical",
        "--provider",
        "codex",
      ], {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(requestedUrl?.pathname).toBe("/search/lexical");
      expect(requestedUrl?.searchParams.get("provider")).toBe("codex");

      const invalid = await runCli([
        "search",
        "--query",
        "effect server",
        "--provider",
        "not-a-provider",
      ], {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(invalid.exitCode).toBe(1);
      expect(invalid.json.error?.type).toBe("CommandInputError");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("remote ingest fails before scanning when no ingest token is configured", async () => {
    const result = await runCli(["ingest", "--provider", "all", "--summary"], {
      QUASAR_SERVER_URL: "http://127.0.0.1:1",
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.command).toBe("ingest");
    expect(result.json.error?.type).toBe("ConfigurationError");
    expect(result.json.error?.details?.acceptedEnv).toEqual(["QUASAR_INGEST_TOKEN"]);
    expect(result.json.error?.details?.acceptedConfigFields).toEqual(["ingestToken"]);
  }, 15_000);
});
