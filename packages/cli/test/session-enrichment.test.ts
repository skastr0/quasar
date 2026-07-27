import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { SESSION_ENRICHMENT_VERSION } from "@skastr0/quasar-protocol";

const packageRoot = join(import.meta.dir, "..");

const runCli = async (
  args: readonly string[],
  env: Record<string, string>,
  stdin = "",
) => {
  const home = mkdtempSync(join(tmpdir(), "quasar-enrichment-cli-"));
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: packageRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: tmpdir(),
      QUASAR_CONFIG: join(home, "missing-config.json"),
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
    stdout,
    stderr,
    json: JSON.parse(stdout) as {
      readonly ok: boolean;
      readonly command: string;
      readonly data?: {
        readonly row?: unknown;
        readonly rows?: readonly unknown[];
        readonly page?: unknown;
      };
      readonly error?: {
        readonly type: string;
        readonly message: string;
      };
    },
  };
};

const enrichment = {
  protocolVersion: SESSION_ENRICHMENT_VERSION,
  sessionId: "codex:session-a",
  namespace: "quasar.analysis.thread-summary",
  schemaVersion: 1,
  producer: "thread-analyzer@1",
  inputHash: "sha256:source-a",
  payload: {
    summary: "A bounded derived finding.",
    topics: ["ingestion"],
  },
  updatedAt: "2026-07-27T12:00:00.000Z",
} as const;

describe("session enrichment CLI", () => {
  test("writes a strict stdin envelope and enumerates every exact filter", async () => {
    let writeBody: unknown;
    let writeToken: string | null = null;
    let listUrl: URL | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST") {
          writeBody = await request.json();
          writeToken = request.headers.get("x-quasar-ingest-token");
          return Response.json({
            ok: true,
            command: "session-enrichment-write",
            data: { row: enrichment },
          });
        }
        listUrl = url;
        return Response.json({
          ok: true,
          command: "session-enrichments",
          data: {
            rows: [enrichment],
            page: { returned: 1, nextCursor: "next-page" },
          },
        });
      },
    });
    const env = {
      QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      QUASAR_INGEST_TOKEN: "test-enrichment-token",
    };

    try {
      const write = await runCli(
        ["enrichment-write", "-"],
        env,
        JSON.stringify(enrichment),
      );
      expect(write.exitCode).toBe(0);
      expect(write.stderr).toBe("");
      expect(write.json).toEqual({
        ok: true,
        command: "enrichment-write",
        data: { row: enrichment },
      });
      expect(writeBody).toEqual(enrichment);
      expect(writeToken as string | null).toBe("test-enrichment-token");

      const list = await runCli([
        "enrichments",
        "--project",
        "project-a",
        "--session",
        enrichment.sessionId,
        "--namespace",
        enrichment.namespace,
        "--producer",
        enrichment.producer,
        "--input-hash",
        enrichment.inputHash,
        "--limit",
        "25",
        "--cursor",
        "opaque-page",
      ], env);
      expect(list.exitCode).toBe(0);
      expect(list.json).toEqual({
        ok: true,
        command: "enrichments",
        data: {
          rows: [enrichment],
          page: { returned: 1, nextCursor: "next-page" },
        },
      });
      expect(Object.fromEntries(listUrl!.searchParams)).toEqual({
        projectKey: "project-a",
        sessionId: enrichment.sessionId,
        namespace: enrichment.namespace,
        producer: enrichment.producer,
        inputHash: enrichment.inputHash,
        limit: "25",
        cursor: "opaque-page",
      });
    } finally {
      await server.stop(true);
    }
  }, 20_000);

  test("publishes nothing when input or server output violates the contract", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests += 1;
        return Response.json({
          ok: true,
          command: "session-enrichments",
          data: {
            rows: [{ ...enrichment, sourceFacts: { provider: "codex" } }],
            page: { returned: 1 },
          },
        });
      },
    });
    const env = {
      QUASAR_SERVER_URL: `http://127.0.0.1:${server.port}`,
      QUASAR_INGEST_TOKEN: "test-enrichment-token",
    };

    try {
      const invalidInput = await runCli(
        ["enrichment-write", "-"],
        env,
        JSON.stringify({
          ...enrichment,
          sourceFacts: { provider: "codex" },
        }),
      );
      expect(invalidInput.exitCode).toBe(1);
      expect(invalidInput.json.ok).toBe(false);
      expect(invalidInput.json.error?.type).toBe(
        "SessionEnrichmentInputError",
      );
      expect(requests).toBe(0);

      const invalidOutput = await runCli(
        ["enrichments", "--limit", "10"],
        env,
      );
      expect(invalidOutput.exitCode).toBe(1);
      expect(invalidOutput.json.ok).toBe(false);
      expect(invalidOutput.json.error?.type).toBe(
        "SessionEnrichmentProtocolError",
      );
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  }, 20_000);
});
