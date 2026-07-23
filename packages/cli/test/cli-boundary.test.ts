import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { QuerySpec } from "@skastr0/quasar-protocol";

import packageJson from "../package.json";

const packageRoot = join(import.meta.dir, "..");

const runCli = async (
  args: readonly string[],
  env: Record<string, string> = {},
  stdin = "",
) => {
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
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
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
      readonly ok?: boolean;
      readonly command?: string;
      readonly protocolVersion?: string;
      readonly kind?: string;
      readonly projection?: unknown;
      readonly page?: unknown;
      readonly items?: readonly unknown[];
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

const emptyQueryResponse = (spec: QuerySpec) => ({
  protocolVersion: spec.protocolVersion,
  kind: spec.kind,
  projection: spec.projection,
  page: { returned: 0 },
  items: [],
});

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

  test("search validates and forwards structured filters to POST /query", async () => {
    let requestedUrl: URL | undefined;
    let requestedSpec: QuerySpec | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestedUrl = new URL(request.url);
        requestedSpec = await request.json() as QuerySpec;
        return Response.json(emptyQueryResponse(requestedSpec));
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
        "--model",
        "gpt-5.6-sol",
        "--fields",
        "sessionId,provider,text,score",
      ], {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(requestedUrl?.pathname).toBe("/query");
      expect(requestedSpec).toMatchObject({
        kind: "search",
        text: "effect server",
        mode: "lexical",
        filters: { providers: ["codex"], model: "gpt-5.6-sol" },
        projection: { detail: "summary", fields: ["sessionId", "provider", "text", "score"] },
      });
      expect(result.json.kind).toBe("search");

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

      const eventOnlyRole = await runCli([
        "search",
        "--query",
        "effect server",
        "--role",
        "thinking",
      ], {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(eventOnlyRole.exitCode).toBe(1);
      expect(eventOnlyRole.json.error?.message).toContain("user, assistant, reasoning");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("query accepts inline JSON, @file, and stdin as the same direct contract", async () => {
    const received: QuerySpec[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const spec = await request.json() as QuerySpec;
        received.push(spec);
        return Response.json(emptyQueryResponse(spec));
      },
    });
    const query = {
      protocolVersion: "quasar.query/v1",
      kind: "sessions",
      filters: { providers: ["codex"] },
      projection: {
        detail: "summary",
        fields: ["sessionId", "provider", "title"],
      },
      page: { limit: 10 },
    };
    const file = join(mkdtempSync(join(tmpdir(), "quasar-query-")), "query.json");
    writeFileSync(file, JSON.stringify(query));
    const env = { QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}` };
    try {
      const inline = await runCli(["query", JSON.stringify(query)], env);
      const fromFile = await runCli(["query", `@${file}`], env);
      const fromStdin = await runCli(["query", "-"], env, JSON.stringify(query));

      for (const result of [inline, fromFile, fromStdin]) {
        expect(result.exitCode).toBe(0);
        expect(result.json.kind).toBe("sessions");
        expect(result.json.ok).toBeUndefined();
      }
      expect(received).toHaveLength(3);
      expect(received.every((spec) => spec.kind === "sessions")).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("query input is schema-validated before server configuration", async () => {
    const result = await runCli(["query", '{"kind":"sessions"}']);

    expect(result.exitCode).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.command).toBe("query");
    expect(result.json.error?.type).not.toBe("ConfigurationError");
  }, 15_000);

  test("schema and examples discovery are local", async () => {
    const schema = await runCli(["schema", "query"]);
    const responseSchema = await runCli(["schema", "--name", "response"]);
    const examples = await runCli(["examples", "session-enrichment"]);

    expect(schema.exitCode).toBe(0);
    expect(schema.json.command).toBe("schema");
    expect(schema.json.data).toEqual(expect.objectContaining({ schemaId: "quasar.query/v1" }));
    expect(responseSchema.json.data).toEqual(expect.objectContaining({ schemaId: "quasar.query-response/v1" }));
    expect(examples.exitCode).toBe(0);
    expect(examples.json.command).toBe("examples");
    expect(examples.json.data).toEqual([
      expect.objectContaining({ schemaId: "quasar.session-enrichment/v1", name: "thread analysis" }),
    ]);
  }, 15_000);

  test("query-backed list commands use cursor projection and reject offset", async () => {
    let requestedSpec: QuerySpec | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestedSpec = await request.json() as QuerySpec;
        return Response.json(emptyQueryResponse(requestedSpec));
      },
    });
    try {
      const result = await runCli([
        "sessions",
        "--provider",
        "codex,claude",
        "--agent-role",
        "builder",
        "--model-provider",
        "openai",
        "--detail",
        "--fields",
        "sessionId,provider,agentRole,modelProvider",
        "--cursor",
        "opaque-next",
        "--limit",
        "25",
      ], {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(requestedSpec).toMatchObject({
        kind: "sessions",
        filters: {
          providers: ["codex", "claude"],
          agentRole: "builder",
          modelProvider: "openai",
        },
        projection: {
          detail: "detail",
          fields: ["sessionId", "provider", "agentRole", "modelProvider"],
        },
        page: { limit: 25, cursor: "opaque-next" },
      });

      const offset = await runCli(["sessions", "--offset", "25"]);
      expect(offset.exitCode).toBe(1);
      expect(offset.json.error?.type).toBe("CommandInputError");
      expect(offset.json.error?.message).toContain("--offset");

      const bareOffset = await runCli(["sessions", "--offset"]);
      expect(bareOffset.exitCode).toBe(1);
      expect(bareOffset.json.error?.message).toContain("--offset");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("tool-call lists omit bodies and id lookup requests detail", async () => {
    const requested: QuerySpec[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const spec = await request.json() as QuerySpec;
        requested.push(spec);
        return Response.json(emptyQueryResponse(spec));
      },
    });
    const env = { QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}` };
    try {
      expect((await runCli(["tool-calls", "--session", "codex:s1"], env)).exitCode).toBe(0);
      expect((await runCli(["tool-call", "--id", "call-1"], env)).exitCode).toBe(0);

      expect(requested[0]?.kind).toBe("toolCalls");
      expect(requested[0]?.projection.detail).toBe("summary");
      expect(requested[0]?.projection.fields).not.toContain("input");
      expect(requested[0]?.projection.fields).not.toContain("output");
      expect(requested[1]).toMatchObject({
        kind: "toolCalls",
        filters: { toolCallId: "call-1" },
        projection: { detail: "detail" },
        page: { limit: 1 },
      });
      expect(requested[1]?.projection.fields).toContain("input");
      expect(requested[1]?.projection.fields).toContain("output");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("option-shaped values stay data while repeated filters and detail remain explicit", async () => {
    const requested: QuerySpec[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const spec = await request.json() as QuerySpec;
        requested.push(spec);
        return Response.json(emptyQueryResponse(spec));
      },
    });
    const env = { QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}` };
    try {
      expect((await runCli(["tool-calls", "--tool", "--detail"], env)).exitCode).toBe(0);
      expect((await runCli([
        "sessions",
        "--provider",
        "codex",
        "--provider",
        "claude",
      ], env)).exitCode).toBe(0);
      expect((await runCli([
        "tool-calls",
        "--tool",
        "Read",
        "--detail",
      ], env)).exitCode).toBe(0);

      expect(requested[0]).toMatchObject({
        kind: "toolCalls",
        filters: { toolName: "--detail" },
        projection: { detail: "summary" },
      });
      expect(requested[0]?.projection.fields).not.toContain("input");
      expect(requested[0]?.projection.fields).not.toContain("output");
      expect(requested[1]).toMatchObject({
        kind: "sessions",
        filters: { providers: ["codex", "claude"] },
        projection: { detail: "summary" },
      });
      expect(requested[2]).toMatchObject({
        kind: "toolCalls",
        filters: { toolName: "Read" },
        projection: { detail: "detail" },
      });
      expect(requested[2]?.projection.fields).toContain("input");
      expect(requested[2]?.projection.fields).toContain("output");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("session --id retains the rich independent-detail endpoint", async () => {
    let requestedUrl: URL | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requestedUrl = new URL(request.url);
        return Response.json({ ok: true, data: { session: {}, pages: {} } });
      },
    });
    try {
      const result = await runCli([
        "session",
        "--id",
        "codex:s1",
        "--message-limit",
        "50",
        "--context-limit",
        "25",
      ], {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(requestedUrl?.pathname).toBe("/session-detail");
      expect(requestedUrl?.searchParams.get("sessionId")).toBe("codex:s1");
      expect(requestedUrl?.searchParams.get("messageLimit")).toBe("50");
      expect(requestedUrl?.searchParams.get("contextLimit")).toBe("25");
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
