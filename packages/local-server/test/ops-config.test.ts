import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("local-server ops config", () => {
  test("Docker persists Quasar machine identity in the data volume", () => {
    const compose = readFileSync(join(repoRoot, "platform/local-server/compose.yaml"), "utf8");

    expect(compose).toContain("QUASAR_HOME: /data/quasar");
    expect(compose).toContain("QUASAR_LOCAL_SQLITE: /data/quasar/quasar.sqlite");
    expect(compose).toContain("QUASAR_SEARCH_DATA_DIR: /data/quasar/search.lance");
  });

  test("operator scripts keep deploy, sync, and maintenance repeatable", () => {
    const pkg = readFileSync(join(repoRoot, "package.json"), "utf8");
    const ops = readFileSync(join(repoRoot, "scripts/local-server-ops.mjs"), "utf8");
    const runbook = readFileSync(join(repoRoot, "docs/operations/local-server-docker-tailscale.md"), "utf8");

    expect(pkg).toContain("local-server:deploy");
    expect(pkg).toContain("local-server:sync-tick");
    expect(pkg).toContain("local-server:sync-install");
    expect(pkg).toContain("local-server:sync-status");
    expect(pkg).toContain("local-server:maintain");
    expect(pkg).toContain("local-server:lance");
    expect(pkg).toContain("local-server:backup");
    expect(ops).toContain("case \"syncTick\"");
    expect(ops).toContain("case \"maintain\"");
    expect(ops).toContain("case \"lance\"");
    expect(ops).toContain("@lancedb/lancedb");
    expect(ops).toContain("VACUUM INTO");
    expect(ops).toContain("quasar-truth-backup.tar");
    expect(ops).toContain("QUASAR_WORKERS_ENABLED=false");
    expect(ops).toContain("QUASAR_SYNC_INGEST_LIMIT:-");
    expect(ops).toContain("limit_arg=\\\"--limit ${QUASAR_SYNC_INGEST_LIMIT}\\\"");
    expect(ops).toContain("bun packages/cli/src/cli.ts ingest --provider all --summary ${limit_arg}");
    const sync = readFileSync(join(repoRoot, "scripts/install-local-server-sync.mjs"), "utf8");
    expect(sync).toContain("com.quasar.local-server-sync");
    expect(sync).toContain("StartInterval");
    expect(sync).toContain("QUASAR_LOCAL_SERVER_SYNC_INTERVAL_SECONDS ?? \"60\"");
    expect(sync).toContain("local-server:sync-tick");
    expect(sync).toContain("QUASAR_LOCAL_SERVER_SYNC_STALE_LOCK_SECONDS");
    expect(sync).toContain("recoveredStaleLock");
    expect(sync).toContain("local-server-sync.lock");
    expect(runbook).toContain("every 60 seconds: `bun run local-server:sync-tick`");
    expect(runbook).toContain("adapter `shouldParseSession` probes");
    expect(runbook).toContain("quasar daemon install --interval-seconds 60");
    expect(runbook).toContain("quasar daemon uninstall");
    expect(runbook).toContain("so a slow first");
    expect(runbook).toContain("Avoid the HTTP maintenance endpoint for long optimize runs");
    expect(runbook).toContain("bun run local-server:lance");
    expect(runbook).toContain("does **not** archive `search.lance` by default");
  });

  test("runbook documents the agent-facing local-server tool contract", () => {
    const cli = readFileSync(join(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    const clientConfig = readFileSync(join(repoRoot, "packages/cli/src/client-config.ts"), "utf8");
    const runbook = readFileSync(join(repoRoot, "docs/operations/local-server-docker-tailscale.md"), "utf8");

    expect(cli).toContain("tool-calls [--session-id id] [--project-key key] [--provider name] [--tool-name name] [--limit n] [--offset n]");
    expect(cli).toContain("tool-call --id id");
    expect(cli).toContain("[--role user|assistant]");
    expect(cli).toContain("daemon install --server http://<mac-mini-tailscale-ip>:6180 --ingest-token <token> [--interval-seconds 60]");
    expect(cli).toContain("com.quasar.remote-ingest");
    expect(cli).toContain("already_running");
    expect(cli).toContain("config.json");
    expect(clientConfig).toContain("localServerUrl");
    expect(clientConfig).toContain("apiUrl");
    expect(clientConfig).toContain("url");
    expect(runbook).toContain("Agent / MCP serving contract");
    expect(runbook).toContain("GET /search/<mode>");
    expect(runbook).toContain("projectKey`, `role=user\\|assistant`, `limit");
    expect(runbook).toContain("sessionId`, `projectKey`, `provider`, `toolName`, `limit`, `offset");
    expect(runbook).toContain("Operator-only commands");
  });
});
