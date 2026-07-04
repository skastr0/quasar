import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("server ops config", () => {
  test("Docker persists Quasar machine identity in the data volume", () => {
    const compose = readFileSync(join(repoRoot, "platform/server/compose.yaml"), "utf8");
    const dockerfile = readFileSync(join(repoRoot, "platform/server/Dockerfile"), "utf8");

    expect(compose).toContain("QUASAR_HOME: /data/quasar");
    expect(compose).toContain("QUASAR_LOCAL_SQLITE: /data/quasar/quasar.sqlite");
    expect(compose).toContain("QUASAR_SEARCH_DATA_DIR: /data/quasar/search.lance");
    expect(compose).toContain("QUASAR_EMBEDDING_PROVIDER: ${QUASAR_EMBEDDING_PROVIDER:-local}");
    expect(compose).toContain("QUASAR_EMBEDDING_MODEL_CACHE_DIR: ${QUASAR_EMBEDDING_MODEL_CACHE_DIR:-/data/quasar/models}");
    expect(compose).toContain("SYNTHETIC_API_KEY: ${SYNTHETIC_API_KEY:-}");
    expect(dockerfile).toContain("COPY scripts ./scripts");
    expect(dockerfile).toContain('CMD ["bun", "packages/server/src/main.ts"');
    expect(dockerfile).toContain("/health");
    expect(dockerfile).not.toContain("packages/server/src/cli.ts");
  });

  test("operator scripts keep deploy and maintenance repeatable", () => {
    const pkg = readFileSync(join(repoRoot, "package.json"), "utf8");
    const ops = readFileSync(join(repoRoot, "scripts/server-ops.mjs"), "utf8");
    const runbook = readFileSync(join(repoRoot, "docs/operations/server-docker-tailscale.md"), "utf8");

    expect(pkg).toContain("server:deploy");
    expect(pkg).toContain("server:maintain");
    expect(pkg).toContain("server:lance");
    expect(pkg).toContain("server:backup");
    expect(pkg).toContain("server:materialize");
    expect(pkg).toContain("server:materialize-staging");
    expect(pkg).toContain("proof:materialize-staging");
    expect(pkg).toContain("server:ready");
    expect(pkg).toContain("server:health");
    expect(ops).toContain("case \"maintain\"");
    expect(ops).toContain("case \"materialize\"");
    expect(ops).toContain("case \"materialize-staging\"");
    expect(ops).toContain("case \"lance\"");
    expect(ops).toContain("case \"ready\"");
    expect(ops).toContain('getJson("/ready")');
    expect(ops).toContain('getJson("/health")');
    expect(ops).toContain("@lancedb/lancedb");
    expect(ops).toContain("VACUUM INTO");
    expect(ops).toContain("quasar-truth-backup.tar");
    expect(ops).toContain("materialize-embedding-vectors");
    expect(ops).toContain("quasar-server_quasar-data");
    expect(ops).toContain("type=volume,source=");
    expect(ops).toContain("target=/source,readonly");
    expect(ops).toContain('optionValue("--staging-dir")');
    expect(ops).toContain("target=/staging");
    expect(ops).toContain("TMPDIR=/staging");
    expect(ops).toContain("validateExternalStagingParent");
    expect(ops).toContain("mkdtempSync(join(tmpdir(), \"quasar-materialize-staging-proof-out-\")");
    expect(ops).toContain("copyFileSync(join(proofDir, outFile), outPath)");
    expect(ops).toContain("copiedReceipt");
    expect(ops).toContain("dockerResult(dockerRunArgs");
    expect(ops).not.toContain('optionValue("--image"');
    expect(ops).toContain('if (command !== "materialize" && command !== "materialize-staging")');
    expect(ops).toContain('optionValue("--require-provider", "local")');
    expect(ops).toContain("--require-provider");
    expect(ops).toContain("materialization-closure-");
    expect(ops).toContain("missing value for");
    expect(runbook).toContain("quasar daemon install --interval-seconds 60");
    expect(runbook).toContain("quasar daemon uninstall");
    expect(runbook).toContain("so a slow first");
    expect(runbook).toContain("Avoid the HTTP maintenance endpoint for long optimize runs");
    expect(runbook).toContain("bun run server:lance");
    expect(runbook).toContain("does **not** archive `search.lance` by default");
    expect(runbook).toContain("embedding.provider = local");
    expect(runbook).toContain("Staged Local Materialization Proof");
    expect(runbook).toContain("proof:materialize-staging --source-db");
    expect(runbook).toContain("server:materialize-staging --out");
    expect(runbook).toContain("quasar-server_quasar-data");
    expect(runbook).toContain("--staging-dir /Volumes/large/quasar-staging");
    expect(runbook).toContain("TMPDIR=/staging");
    expect(runbook).toContain("QUASAR_EMBEDDING_PROVIDER=local");
  });

  test("materialize staging rejects missing external staging directories before docker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-server-ops-staging-dir-"));
    try {
      const missing = join(dir, "missing");
      const proc = Bun.spawn([
        "bun",
        "scripts/server-ops.mjs",
        "materialize-staging",
        "--staging-dir",
        missing,
        "--out",
        join(dir, "proof.json"),
      ], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(2);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        error: `--staging-dir does not exist: ${missing}`,
      });
      expect(existsSync(join(dir, "proof.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("materialize staging rejects non-directory staging paths before docker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-server-ops-staging-file-"));
    try {
      const filePath = join(dir, "staging-file");
      writeFileSync(filePath, "not a directory");
      const proc = Bun.spawn([
        "bun",
        "scripts/server-ops.mjs",
        "materialize-staging",
        "--staging-dir",
        filePath,
        "--out",
        join(dir, "proof.json"),
      ], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(2);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        error: `--staging-dir is not a directory: ${filePath}`,
      });
      expect(existsSync(join(dir, "proof.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("server-side history ingestion paths are removed", () => {
    const pkg = readFileSync(join(repoRoot, "package.json"), "utf8");
    const ops = readFileSync(join(repoRoot, "scripts/server-ops.mjs"), "utf8");
    const compose = readFileSync(join(repoRoot, "platform/server/compose.yaml"), "utf8");

    expect(pkg).not.toContain("server:ingest");
    expect(pkg).not.toContain("server:sync-tick");
    expect(pkg).not.toContain("server:sync-install");
    expect(pkg).not.toContain("server:sync-status");
    expect(ops).not.toContain("operator-ingest");
    expect(ops).not.toContain("syncTick");
    expect(ops).not.toContain("QUASAR_SYNC_INGEST_LIMIT");
    expect(compose).not.toContain("/history/");
    expect(compose).not.toContain("QUASAR_CLAUDE_ROOT");
    expect(existsSync(join(repoRoot, "scripts/install-server-sync.mjs"))).toBe(false);
  });

  test("runbook documents the agent-facing server tool contract", () => {
    const cli = readFileSync(join(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    const clientConfig = readFileSync(join(repoRoot, "packages/cli/src/client-config.ts"), "utf8");
    const runbook = readFileSync(join(repoRoot, "docs/operations/server-docker-tailscale.md"), "utf8");

    expect(cli).toContain("tool-calls [--session-id id] [--project-key key] [--provider name] [--tool-name name] [--limit n] [--offset n]");
    expect(cli).toContain("tool-call --id id");
    expect(cli).toContain("[--role user|assistant]");
    expect(cli).toContain("daemon install --server https://<quasar-service-tailnet-hostname> --ingest-token <token> [--interval-seconds 60]");
    expect(cli).toContain("com.quasar.remote-ingest");
    expect(cli).toContain("already_running");
    expect(cli).toContain("config.json");
    expect(clientConfig).toContain("serverUrl");
    expect(clientConfig).toContain("ingestToken");
    expect(runbook).toContain("Agent / MCP serving contract");
    expect(runbook).toContain("GET /search/<mode>");
    expect(runbook).toContain("remote write ingest fails closed before provider scanning");
    expect(runbook).toContain("projectKey`, `role=user\\|assistant`, `limit");
    expect(runbook).toContain("sessionId`, `projectKey`, `provider`, `toolName`, `limit`, `offset");
    expect(runbook).toContain("Operator-only commands");
  });
});
