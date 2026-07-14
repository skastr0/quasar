/**
 * Read-command golden lock for the SDK consolidation (QSR SDK track,
 * "CLI read/search consolidation onto SDK").
 *
 * projects/sessions/messages/tool-calls/ingest-runs now resolve through
 * @skastr0/quasar-sdk's QuasarClient instead of hand-rolled fetchServer.
 * The contract this locks: the CLI's stdout envelope for each of those
 * commands must stay byte-identical to the server's raw envelope for the
 * same query -- proven live, not against a committed fixture, so the test
 * catches drift from either side (CLI wire-mapping or server response
 * shape) for as long as the live server has data.
 *
 * Live-gated: this is the recon's LIVE check, not a fixture round-trip.
 * CI without tailnet access skips the whole suite rather than failing --
 * a server outage must never masquerade as an SDK regression (see
 * recon-quasar-sdk risk #5). The SDK's own schema/decode tests
 * (packages/sdk/test) already cover the fixture-based, tailnet-independent
 * path.
 */

import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { configuredServerUrl } from "../src/client-config";

const packageRoot = join(import.meta.dir, "..");

const resolveLiveServer = async (): Promise<string | undefined> => {
  const base = configuredServerUrl();
  if (base === undefined) return undefined;
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
    return response.ok ? base : undefined;
  } catch {
    return undefined;
  }
};

const liveServer = await resolveLiveServer();

const runCli = async (args: readonly string[]) => {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args, "--server", liveServer as string], {
    cwd: packageRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

/** Same serialization fetchServer used pre-migration (writeJson: pretty
 * 2-space JSON + trailing newline) so this is a literal byte comparison,
 * not a structural one. */
const fetchRawEnvelope = async (path: string): Promise<{ readonly text: string; readonly body: any }> => {
  const response = await fetch(`${liveServer}${path}`);
  const body = await response.json();
  return { text: `${JSON.stringify(body, null, 2)}\n`, body };
};

describe.skipIf(liveServer === undefined)("read-command goldens (live server)", () => {
  test("projects: CLI stdout is byte-identical to the raw server envelope", async () => {
    const [raw, cli] = await Promise.all([fetchRawEnvelope("/projects?limit=5"), runCli(["projects", "--limit", "5"])]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toBe(raw.text);
  }, 30_000);

  test("sessions: CLI stdout is byte-identical to the raw server envelope, including null columns", async () => {
    const [raw, cli] = await Promise.all([fetchRawEnvelope("/sessions?limit=20"), runCli(["sessions", "--limit", "20"])]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toBe(raw.text);
    // Guards the wireSession null-restoration itself: SQL NULL columns
    // (parentSessionId here) must decode-then-reserialize as explicit
    // `null`, not silently drop the key.
    expect(raw.text).toContain('"parentSessionId": null');
  }, 30_000);

  test("messages: CLI stdout is byte-identical to the raw server envelope", async () => {
    const seed = await fetchRawEnvelope("/sessions?limit=1");
    const sessionId = seed.body.data.rows[0].sessionId as string;
    const [raw, cli] = await Promise.all([
      fetchRawEnvelope(`/messages?sessionId=${encodeURIComponent(sessionId)}&limit=20`),
      runCli(["messages", "--session-id", sessionId, "--limit", "20"]),
    ]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toBe(raw.text);
  }, 30_000);

  test("tool-calls: CLI stdout is byte-identical to the raw server envelope", async () => {
    const [raw, cli] = await Promise.all([fetchRawEnvelope("/tool-calls?limit=20"), runCli(["tool-calls", "--limit", "20"])]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toBe(raw.text);
  }, 30_000);

  test("ingest-runs: CLI stdout is byte-identical to the raw server envelope", async () => {
    const [raw, cli] = await Promise.all([fetchRawEnvelope("/ingest-runs?limit=20"), runCli(["ingest-runs", "--limit", "20"])]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toBe(raw.text);
  }, 30_000);

  // --- Deliberately NOT migrated onto QuasarClient this batch. These guard
  // the exact regressions that ruled each one out, so a future "finish the
  // migration" pass re-discovers the landmine before hitting it in prod.

  test("tool-call: a missing id stays a graceful ok:true row:null (server's notFound guard is dead code)", async () => {
    const cli = await runCli(["tool-call", "--id", "golden-lock-does-not-exist"]);
    expect(cli.exitCode).toBe(0);
    const parsed = JSON.parse(cli.stdout);
    expect(parsed).toEqual({ ok: true, command: "tool-call", data: { row: null } });
  }, 30_000);

  test("search: stdout still carries receipt (fields the SDK's SearchHit[] contract excludes)", async () => {
    const cli = await runCli(["search", "--query", "auth", "--mode", "lexical", "--limit", "1"]);
    expect(cli.exitCode).toBe(0);
    const parsed = JSON.parse(cli.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("receipt");
  }, 30_000);
});
