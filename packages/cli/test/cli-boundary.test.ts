import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

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

const resourcePage = (url: URL, nextOffset: number | null = null) => ({
  limit: Number(url.searchParams.get("limit")),
  offset: Number(url.searchParams.get("offset")),
  nextOffset,
});

const toolCallDetailRow = {
  toolCallId: "call-1",
  sessionId: "codex:s1",
  projectKey: "quasar",
  provider: "codex",
  sequence: 3,
  toolName: "exec_command",
  timestamp: null,
  status: "completed",
  startedAt: null,
  completedAt: null,
  inputBytes: 13,
  outputBytes: 2,
  agentName: null,
  agentRole: "builder",
  model: "gpt-5.6-sol",
  modelProvider: "openai",
  inputText: "{\"cmd\":\"pwd\"}",
  outputText: "ok",
};

const emptyResourceResponse = (
  request: Request,
  nextOffset: number | null = null,
): Response => {
  const url = new URL(request.url);
  if (url.pathname === "/tool-call") {
    return Response.json({
      ok: true,
      command: "tool-call",
      data: { row: toolCallDetailRow },
    });
  }
  if (url.pathname.startsWith("/search/")) {
    return Response.json({
      ok: true,
      command: url.pathname.slice(1),
      data: {
        matches: [],
        page: resourcePage(url, nextOffset),
        receipt: {},
        degraded: false,
      },
    });
  }
  return Response.json({
    ok: true,
    command: url.pathname.slice(1),
    data: { rows: [], page: resourcePage(url, nextOffset) },
  });
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

  test("search validates and forwards structured filters to the canonical GET resource", async () => {
    let requestedUrl: URL | undefined;
    let requestedMethod: string | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requestedUrl = new URL(request.url);
        requestedMethod = request.method;
        return emptyResourceResponse(request);
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
      expect(requestedMethod).toBe("GET");
      expect(requestedUrl?.pathname).toBe("/search/lexical");
      expect(requestedUrl?.searchParams.get("q")).toBe("effect server");
      expect(requestedUrl?.searchParams.get("provider")).toBe("codex");
      expect(requestedUrl?.searchParams.get("model")).toBe("gpt-5.6-sol");
      expect(result.json.projection).toEqual({
        detail: "summary",
        fields: ["sessionId", "provider", "text", "score"],
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

  test("query accepts inline JSON, @file, and stdin as the same local composition contract", async () => {
    const received: URL[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        received.push(new URL(request.url));
        return emptyResourceResponse(request);
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
      expect(received.every((url) => url.pathname === "/sessions")).toBe(true);
      expect(received.every((url) => url.searchParams.get("provider") === "codex")).toBe(true);
      expect(received.every((url) => url.searchParams.get("limit") === "10")).toBe(true);
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
    const requested: URL[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requested.push(new URL(request.url));
        return emptyResourceResponse(request, requested.length === 1 ? 25 : null);
      },
    });
    try {
      const args = [
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
        "--limit",
        "25",
      ];
      const first = await runCli(args, {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });

      expect(first.exitCode).toBe(0);
      expect(requested[0]?.pathname).toBe("/sessions");
      expect(Object.fromEntries(requested[0]?.searchParams ?? [])).toMatchObject({
        provider: "codex,claude",
        agentRole: "builder",
        modelProvider: "openai",
        limit: "25",
        offset: "0",
      });
      expect(first.json.projection).toEqual({
        detail: "detail",
        fields: ["sessionId", "provider", "agentRole", "modelProvider"],
      });
      const cursor = (first.json.page as { readonly nextCursor?: string }).nextCursor;
      expect(typeof cursor).toBe("string");

      const second = await runCli([...args, "--cursor", cursor!], {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(second.exitCode).toBe(0);
      expect(requested[1]?.searchParams.get("offset")).toBe("25");

      const drifted = await runCli([...args, "--provider", "grok", "--cursor", cursor!], {
        QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(drifted.exitCode).toBe(1);
      expect(drifted.json.error?.type).toBe("QueryInputError");
      expect(requested).toHaveLength(2);

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
    const requested: URL[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requested.push(new URL(request.url));
        return emptyResourceResponse(request);
      },
    });
    const env = { QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}` };
    try {
      const list = await runCli(["tool-calls", "--session", "codex:s1"], env);
      const detail = await runCli(["tool-call", "--id", "call-1"], env);
      expect(list.exitCode).toBe(0);
      expect(detail.exitCode).toBe(0);

      expect(requested[0]?.pathname).toBe("/tool-calls");
      expect(requested[0]?.searchParams.get("sessionId")).toBe("codex:s1");
      expect(list.json.projection).toEqual(expect.objectContaining({ detail: "summary" }));
      expect((list.json.projection as { fields: string[] }).fields).not.toContain("input");
      expect((list.json.projection as { fields: string[] }).fields).not.toContain("output");
      expect(requested[1]?.pathname).toBe("/tool-call");
      expect(requested[1]?.searchParams.get("id")).toBe("call-1");
      expect((detail.json.projection as { fields: string[] }).fields).toContain("input");
      expect((detail.json.projection as { fields: string[] }).fields).toContain("output");
      expect(detail.json.items?.[0]).toMatchObject({
        toolCallId: "call-1",
        input: { cmd: "pwd" },
        output: "ok",
      });

      const explicitBulkBody = await runCli(["tool-calls", "--detail", "--fields", "toolCallId,input"], env);
      expect(explicitBulkBody.exitCode).toBe(1);
      expect(explicitBulkBody.json.error?.type).toBe("QueryInputError");
      expect(requested).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("option-shaped values stay data while repeated filters and detail remain explicit", async () => {
    const requested: URL[] = [];
    const results: Awaited<ReturnType<typeof runCli>>[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requested.push(new URL(request.url));
        return emptyResourceResponse(request);
      },
    });
    const env = { QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}` };
    try {
      results.push(await runCli(["tool-calls", "--tool", "--detail"], env));
      results.push(await runCli([
        "sessions",
        "--provider",
        "codex",
        "--provider",
        "claude",
      ], env));
      results.push(await runCli([
        "tool-calls",
        "--tool",
        "Read",
        "--detail",
      ], env));
      expect(results.every((result) => result.exitCode === 0)).toBe(true);

      expect(requested[0]?.pathname).toBe("/tool-calls");
      expect(requested[0]?.searchParams.get("toolName")).toBe("--detail");
      expect(requested[1]?.pathname).toBe("/sessions");
      expect(requested[1]?.searchParams.get("provider")).toBe("codex,claude");
      expect(requested[2]?.pathname).toBe("/tool-calls");
      expect(requested[2]?.searchParams.get("toolName")).toBe("Read");
      expect((results[0]?.json.projection as { fields: string[] }).fields).not.toContain("input");
      expect((results[2]?.json.projection as { fields: string[] }).fields).not.toContain("input");
      expect((results[2]?.json.projection as { fields: string[] }).fields).not.toContain("output");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("terminal value options fail closed before server dispatch or config fallback", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return Response.json({ ok: true });
      },
    });
    const env = { QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}` };
    try {
      const tool = await runCli(["tool-calls", "--tool"], env);
      expect(tool.exitCode).toBe(1);
      expect(tool.json.command).toBe("tool-calls");
      expect(tool.json.error?.type).toBe("CommandInputError");
      expect(tool.json.error?.message).toContain("--tool requires a value");

      const configuredServer = await runCli(["stats", "--server"], env);
      expect(configuredServer.exitCode).toBe(1);
      expect(configuredServer.json.command).toBe("stats");
      expect(configuredServer.json.error?.type).toBe("CommandInputError");
      expect(configuredServer.json.error?.message).toContain("--server requires a value");

      expect(requests).toBe(0);
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
