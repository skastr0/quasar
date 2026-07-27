import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import {
  RESEARCH_EXPORT_PROTOCOL_VERSION,
  projectQuasarTrajectory,
  protocolContracts,
  type ResearchExportFrame,
  type ResearchExportScanKey,
} from "@skastr0/quasar-protocol";

const packageRoot = join(import.meta.dir, "..");
const mapped = protocolContracts.mappedSession.examples[0].input;
const trajectory = projectQuasarTrajectory(mapped, {
  includeReasoning: false,
  includeToolResults: true,
});

const runCli = async (
  args: readonly string[],
  environment: Record<string, string>,
) => {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: packageRoot,
    env: {
      PATH: process.env.PATH ?? "",
      ...environment,
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
    stdout,
    stderr,
    json: JSON.parse(stdout) as {
      readonly ok: boolean;
      readonly data?: {
        readonly outputPath: string;
        readonly complete: boolean;
        readonly nextCursor?: string;
        readonly snapshot: string;
      };
      readonly error?: {
        readonly message: string;
      };
    },
  };
};

const artifact = (
  after: ResearchExportScanKey | null,
  next: ResearchExportScanKey | null,
  checksumOverride?: string,
) => {
  const sequence = after === null ? 0 : after.sequence + 1;
  const frames: ResearchExportFrame[] = [
    {
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "manifest",
      snapshot: "corpus-test:4",
      filters: { projectKey: "quasar" },
      page: { limit: 1, after },
      trajectoryScope: "first-matching-message-in-scan",
      trajectoryProjection: {
        includeReasoning: false,
        includeToolResults: true,
      },
    },
    {
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "message",
      message: {
        messageId: `message-${sequence}`,
        sessionId: mapped.session.sessionId,
        sequence,
        role: "user",
        text: `message ${sequence}`,
        timestamp: null,
        projectKey: "quasar",
        provider: mapped.session.provider,
        title: null,
        agentName: mapped.session.agentName,
        agentRole: null,
        model: null,
        modelProvider: null,
        executionContextId: null,
        reasoningEffort: null,
      },
    },
  ];
  const includesTrajectory =
    after === null || after.sessionId !== mapped.session.sessionId;
  if (includesTrajectory) {
    frames.push({
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "trajectory",
      sessionId: mapped.session.sessionId,
      trajectory,
    });
  }
  const content = frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
  const receipt: ResearchExportFrame = {
    protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
    kind: "receipt",
    snapshot: "corpus-test:4",
    counts: {
      messages: 1,
      trajectories: includesTrajectory ? 1 : 0,
    },
    content: {
      bytes: Buffer.byteLength(content),
      sha256: checksumOverride
        ?? `sha256:${createHash("sha256").update(content).digest("hex")}`,
    },
    next,
  };
  return `${content}${JSON.stringify(receipt)}\n`;
};

describe("research-export CLI", () => {
  test("writes verified shards and resumes with a snapshot-bound cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-research-export-"));
    const requested: URL[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requested.push(url);
        const afterSessionId = url.searchParams.get("afterSessionId");
        const after = afterSessionId === null
          ? null
          : {
              sessionId: afterSessionId,
              sequence: Number(url.searchParams.get("afterSequence")),
            };
        return new Response(
          artifact(
            after,
            after === null
              ? {
                  sessionId: mapped.session.sessionId,
                  sequence: 0,
                }
              : null,
          ),
          {
            headers: {
              "content-type": "application/x-ndjson",
            },
          },
        );
      },
    });
    const environment = {
      HOME: dir,
      QUASAR_CONFIG: join(dir, "missing-config.json"),
    };
    try {
      const firstPath = join(dir, "first.ndjson");
      const first = await runCli([
        "research-export",
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--project",
        "quasar",
        "--limit",
        "1",
        "--exclude-reasoning",
        "--out",
        firstPath,
      ], environment);
      expect(first.exitCode).toBe(0);
      expect(first.stderr).toBe("");
      const nextCursor = first.json.data?.nextCursor;
      expect(typeof nextCursor).toBe("string");
      expect(first.json).toMatchObject({
        ok: true,
        data: {
          outputPath: firstPath,
          complete: false,
          snapshot: "corpus-test:4",
        },
      });
      expect(readFileSync(firstPath, "utf8")).toBe(
        artifact(
          null,
          {
            sessionId: mapped.session.sessionId,
            sequence: 0,
          },
        ),
      );

      const secondPath = join(dir, "second.ndjson");
      const second = await runCli([
        "research-export",
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--project",
        "quasar",
        "--limit",
        "1",
        "--exclude-reasoning",
        "--cursor",
        nextCursor!,
        "--out",
        secondPath,
      ], environment);
      expect(second.exitCode).toBe(0);
      expect(second.json).toMatchObject({
        ok: true,
        data: {
          outputPath: secondPath,
          complete: true,
          snapshot: "corpus-test:4",
        },
      });
      expect(requested[1]!.pathname).toBe("/research-export");
      expect(requested[1]!.searchParams.get("snapshot")).toBe(
        "corpus-test:4",
      );
      expect(requested[1]!.searchParams.get("afterSessionId")).toBe(
        mapped.session.sessionId,
      );
      expect(requested[1]!.searchParams.get("afterSequence")).toBe("0");
    } finally {
      await server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discards a shard whose checksum receipt is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-research-export-bad-"));
    const outputPath = join(dir, "bad.ndjson");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          artifact(
            null,
            null,
            `sha256:${"0".repeat(64)}`,
          ),
          {
            headers: {
              "content-type": "application/x-ndjson",
            },
          },
        ),
    });
    try {
      const result = await runCli([
        "research-export",
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--project",
        "quasar",
        "--limit",
        "1",
        "--exclude-reasoning",
        "--out",
        outputPath,
      ], {
        HOME: dir,
        QUASAR_CONFIG: join(dir, "missing-config.json"),
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining("receipt"),
        },
      });
      expect(existsSync(outputPath)).toBe(false);
      expect(
        readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      await server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
