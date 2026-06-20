import { statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getFunctionName } from "convex/server";

import { adaptersByProvider, loadMachineIdentity, sourceFingerprintFor } from "@skastr0/quasar-core";

import { runProviderIngest, type IngestMutationClient } from "../src/commands/ingest";
import { openIngestLedger } from "../src/ingest-ledger";
import { scanAdapter } from "../src/commands/scan";

const PROJECT_DIR = "-tmp-quasar-scan-project";
const ACTION_SECRET = "test-action-secret";

class FakeConvex implements IngestMutationClient {
  readonly calls: string[] = [];
  indexStatus = "indexed";
  readonly committed = new Map<string, string>();

  countOf(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }

  reset(): void {
    this.calls.length = 0;
  }

  mutation(reference: unknown, args: unknown): Promise<unknown> {
    return this.call(reference, args);
  }

  action(reference: unknown, args: unknown): Promise<unknown> {
    return this.call(reference, args);
  }

  call(reference: unknown, args: unknown): Promise<unknown> {
    const name = getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
    this.calls.push(name);
    const payload = args as Record<string, unknown>;
    if (name === "quasar:upsertProject") return Promise.resolve({});
    if (name === "quasar:beginSessionIngest") {
      const sessionId = payload.sessionId as string;
      const fingerprint = payload.sourceFingerprint as string;
      const force = payload.force === true;
      return Promise.resolve({ skipped: !force && this.committed.get(sessionId) === fingerprint });
    }
    if (name === "quasar:deleteSessionTurns") return Promise.resolve({ deleted: 0, batchSize: 250 });
    if (name === "quasar:insertMessages") return Promise.resolve({});
    if (name === "quasar:insertToolCalls") return Promise.resolve({});
    if (name === "quasar:commitSessionIngest") return Promise.resolve({});
    if (name === "quasar:pruneEmptyProjects") return Promise.resolve({});
    if (name === "search:indexBatchForIngest") {
      const sessionIds = payload.sessionIds as string[];
      return Promise.resolve({
        status: this.indexStatus,
        sessionsSeen: sessionIds.length,
        messagesSeen: sessionIds.length,
      });
    }
    if (name === "ingest:ingestBatch") {
      const force = payload.force === true;
      const sessions = payload.sessions as Array<{
        readonly sourceFingerprint: string;
        readonly session: { readonly sessionId: string };
      }>;
      let sessionsWritten = 0;
      let sessionsSkipped = 0;
      const results: Array<{
        readonly sessionId: string;
        readonly sourceFingerprint: string;
        readonly status: "ok" | "skipped";
        readonly skipped: boolean;
        readonly written: boolean;
      }> = [];
      for (const entry of sessions) {
        const sessionId = entry.session.sessionId;
        const fingerprint = entry.sourceFingerprint;
        const known = this.committed.get(sessionId);
        if (!force && known === fingerprint) {
          sessionsSkipped += 1;
          results.push({
            sessionId,
            sourceFingerprint: fingerprint,
            status: "skipped" as const,
            skipped: true,
            written: false,
          });
          continue;
        }
        sessionsWritten += 1;
        results.push({
          sessionId,
          sourceFingerprint: fingerprint,
          status: "ok" as const,
          skipped: false,
          written: true,
        });
      }
      for (const result of results) {
        if (result.written) this.committed.set(result.sessionId, result.sourceFingerprint);
      }
      return Promise.resolve({
        sessionsWritten,
        sessionsSkipped,
        messagesWritten: sessionsWritten,
        toolCallsWritten: 0,
        sessions: results,
        index: {
          status: "indexed",
          sessionsSeen: sessions.length,
          messagesSeen: sessions.length,
          messagesEmbedded: 0,
          messagesReused: 0,
          keysDeleted: 0,
          embeddingsConfigured: false,
        },
      });
    }
    return Promise.resolve({});
  }
}

const writeSession = (root: string, name: string, turns: number): string => {
  const path = join(root, "projects", PROJECT_DIR, `${name}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < turns; i += 1) {
    lines.push(
      JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        cwd: "/tmp/quasar-scan-project",
        uuid: `${name}-${i}`,
        timestamp: `2026-06-16T00:00:0${i}.000Z`,
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `turn ${i} of ${name}` }],
        },
      }),
    );
  }
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
};

let root: string;
let ledgerHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quasar-scan-root-"));
  ledgerHome = mkdtempSync(join(tmpdir(), "quasar-scan-home-"));
  mkdirSync(join(root, "projects", PROJECT_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(ledgerHome, { recursive: true, force: true });
});

const ingest = (client: FakeConvex) =>
  runProviderIngest({
    provider: "claude",
    root,
    client,
    ledgerHome,
    actionSecret: ACTION_SECRET,
  });

describe("scanAdapter", () => {
  test("cold scan: all sessions classified as new, counts and bytes reported", async () => {
    writeSession(root, "alpha", 2);
    writeSession(root, "bravo", 4);

    const ledger = openIngestLedger(ledgerHome);
    const adapter = adaptersByProvider.get("claude")!;
    const report = await scanAdapter(
      adapter,
      ledger,
      { root },
      new Date().toISOString(),
    );
    ledger.close();

    expect(report.provider).toBe("claude");
    expect(report.totalSessionsDiscovered).toBe(2);
    expect(report.ingestedSessions).toBe(0);
    expect(report.newOrChangedSessions).toBe(2);
    expect(report.estimatedIngest.sessions).toBe(2);
    // 2 turns alpha + 4 turns bravo = 6 messages (user+assistant interleaved)
    expect(report.estimatedIngest.messages).toBe(6);
    expect(report.estimatedIngest.toolCalls).toBe(0);
    expect(report.estimatedIngest.bytes).toBeGreaterThan(0);
    expect(report.estimatedIngest.approxMB).toBeGreaterThan(0);
    // No usage records in claude JSONL → estimated from bytes
    expect(report.estimatedIngest.estimatedTokens).toBeGreaterThan(0);
    expect(report.estimatedIngest.reportedTokens).toBe(0);
  });

  test("warm scan: ledger hit skips parse, classifies as ingested", async () => {
    writeSession(root, "alpha", 2);
    writeSession(root, "bravo", 2);

    // Ingest sessions to populate the ledger.
    const client = new FakeConvex();
    const ingestReport = await ingest(client);
    expect(ingestReport.sessionsWritten).toBe(2);

    // Now scan — all sessions should be classified as "ingested".
    const ledger = openIngestLedger(ledgerHome);
    const report = await scanAdapter(
      adaptersByProvider.get("claude")!,
      ledger,
      { root },
      new Date().toISOString(),
    );
    ledger.close();

    expect(report.totalSessionsDiscovered).toBe(2);
    expect(report.ingestedSessions).toBe(2);
    expect(report.newOrChangedSessions).toBe(0);
    expect(report.estimatedIngest.sessions).toBe(0);
    expect(report.estimatedIngest.messages).toBe(0);
    expect(report.estimatedIngest.bytes).toBe(0);
  });

  test("verbose mode includes per-session details", async () => {
    writeSession(root, "alpha", 2);

    const ledger = openIngestLedger(ledgerHome);
    const report = await scanAdapter(
      adaptersByProvider.get("claude")!,
      ledger,
      { root, verbose: true },
      new Date().toISOString(),
    );
    ledger.close();

    expect(report.sessionDetails).toBeDefined();
    expect(report.sessionDetails!.length).toBe(1);
    const detail = report.sessionDetails![0];
    expect(detail.status).toBe("new");
    expect(detail.messages).toBe(2);
    expect(detail.bytes).toBeGreaterThan(0);
  });

  test("empty root yields no_data_found diagnostic", async () => {
    const ledger = openIngestLedger(ledgerHome);
    const report = await scanAdapter(
      adaptersByProvider.get("claude")!,
      ledger,
      { root: join(root, "nonexistent") },
      new Date().toISOString(),
    );
    ledger.close();

    expect(report.totalSessionsDiscovered).toBe(0);
    expect(report.ingestedSessions).toBe(0);
    expect(report.newOrChangedSessions).toBe(0);
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect(report.diagnostics[0].status).toBe("no_data_found");
  });

  test("adapter without stream returns diagnostic", async () => {
    const noStreamAdapter = {
      id: "fake-no-stream",
      provider: "codex" as const,
      displayName: "Fake No Stream",
      stable: true,
      defaultRoot: () => undefined,
      read: async () => ({ sourceRoots: [], sessions: [], diagnostics: [] }),
    };
    const ledger = openIngestLedger(ledgerHome);
    const report = await scanAdapter(
      noStreamAdapter,
      ledger,
      {},
      new Date().toISOString(),
    );
    ledger.close();

    expect(report.totalSessionsDiscovered).toBe(0);
    expect(report.diagnostics.length).toBe(1);
    expect(report.diagnostics[0].status).toBe("no_data_found");
  });

  test("partial ingest: only new sessions counted, ingested skipped", async () => {
    writeSession(root, "alpha", 2);
    writeSession(root, "bravo", 2);

    // Ingest only one session (limit=1).
    const client = new FakeConvex();
    await runProviderIngest({
      provider: "claude",
      root,
      client,
      ledgerHome,
      actionSecret: ACTION_SECRET,
      limit: 1,
    });

    // Now scan — 1 ingested, 1 new.
    const ledger = openIngestLedger(ledgerHome);
    const report = await scanAdapter(
      adaptersByProvider.get("claude")!,
      ledger,
      { root },
      new Date().toISOString(),
    );
    ledger.close();

    expect(report.totalSessionsDiscovered).toBe(2);
    expect(report.ingestedSessions).toBe(1);
    expect(report.newOrChangedSessions).toBe(1);
    expect(report.estimatedIngest.sessions).toBe(1);
    expect(report.estimatedIngest.messages).toBe(2);
  });
});
