import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("server ops config", () => {
  test("Docker persists Quasar machine identity in the data volume", () => {
    const compose = readFileSync(join(repoRoot, "platform/server/compose.yaml"), "utf8");
    const dockerfile = readFileSync(join(repoRoot, "platform/server/Dockerfile"), "utf8");

    expect(compose).toContain("QUASAR_HOME: /data/quasar");
    expect(compose).toContain("QUASAR_LOCAL_SQLITE: /data/quasar/quasar.sqlite");
    expect(compose).not.toContain("QUASAR_SEARCH_DATA_DIR");
    // Provider is pinned — a flip is an explicit receipted cutover, never a deploy side-effect.
    expect(compose).toContain("QUASAR_EMBEDDING_PROVIDER: synthetic");
    // Defaults to the Dockerfile-baked path (image's own writable layer), NOT
    // under /data/quasar: that path is the quasar-data VOLUME, and an empty
    // named volume mounted there would shadow the baked fp32 model.
    expect(compose).toContain("QUASAR_EMBEDDING_MODEL_CACHE_DIR: ${QUASAR_EMBEDDING_MODEL_CACHE_DIR:-/app/.model-cache}");
    expect(dockerfile).toContain("ENV QUASAR_EMBEDDING_MODEL_CACHE_DIR=/app/.model-cache");
    expect(dockerfile).toContain("bake-onnx-model");
    expect(compose).toContain("SYNTHETIC_API_KEY: ${SYNTHETIC_API_KEY:-}");
    expect(dockerfile).not.toContain("QUASAR_SEARCH_DATA_DIR");
    expect(dockerfile).toContain(
      "COPY packages/protocol/package.json packages/protocol/package.json",
    );
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
    expect(pkg).toContain("server:backup");
    expect(pkg).toContain("server:materialize");
    expect(pkg).not.toContain("server:materialize-staging");
    expect(pkg).not.toContain("proof:materialize-staging");
    expect(pkg).not.toContain("proof:replay-cache-staging");
    expect(pkg).toContain("server:ready");
    expect(pkg).toContain("server:health");
    expect(ops).toContain("case \"materialize\"");
    expect(ops).not.toContain("materialize-staging");
    expect(ops).toContain("case \"ready\"");
    expect(ops).toContain('getJson("/ready")');
    expect(ops).toContain('getJson("/health")');
    expect(ops).toContain("VACUUM INTO");
    expect(ops).toContain("quasar-truth-backup.tar");
    expect(ops).toContain("materialize-embedding-vectors");
    expect(ops).toContain('if (command !== "materialize")');
    expect(ops).toContain("--require-provider");
    expect(ops).toContain("materialization-closure-");
    expect(ops).toContain("missing value for");
    expect(runbook).toContain("quasar daemon install --interval-seconds 60");
    expect(runbook).toContain("quasar daemon uninstall");
    expect(runbook).toContain("so a slow first");
    expect(runbook).not.toContain("Staged Local Materialization Proof");
    expect(runbook).not.toContain("materialize-staging");
    expect(runbook).not.toContain("server:lance");
    expect(runbook).not.toContain("server:maintain");
    expect(runbook).toContain("SemanticDisabled");
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

  test("otel-lgtm is an opt-in compose profile; OTLP base is explicit only", () => {
    const compose = readFileSync(join(repoRoot, "platform/server/compose.yaml"), "utf8");
    const envExample = readFileSync(join(repoRoot, "platform/server/.env.example"), "utf8");
    const sinkDoc = readFileSync(join(repoRoot, "docs/operations/observability-sink.md"), "utf8");
    const watchdogDoc = readFileSync(
      join(repoRoot, "docs/architecture/observability-sink-and-watchdog.md"),
      "utf8",
    );
    const runbook = readFileSync(join(repoRoot, "docs/operations/server-docker-tailscale.md"), "utf8");

    // Profile-gated service (not in the default service graph).
    expect(compose).toContain("grafana/otel-lgtm");
    expect(compose).toContain('profiles: ["otel"]');
    expect(compose).toContain("required: false");
    // OTLP base is explicit only — never ${COMPOSE_PROFILES:+…} (fires on any non-empty).
    expect(compose).toContain("QUASAR_OTLP_BASE_URL: ${QUASAR_OTLP_BASE_URL:-}");
    expect(compose).not.toContain("COMPOSE_PROFILES:+");
    expect(compose).not.toContain("${COMPOSE_PROFILES:");
    // Enable docs list both envs.
    expect(envExample).toContain("COMPOSE_PROFILES=otel");
    expect(envExample).toContain("QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318");
    expect(envExample).toContain("OFF by default");
    expect(sinkDoc).toContain("COMPOSE_PROFILES=otel");
    expect(sinkDoc).toContain("QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318");
    expect(sinkDoc).toContain("http://localhost:3000");
    expect(sinkDoc).toContain("quasar-server");
    expect(watchdogDoc).toContain("opt-in");
    expect(watchdogDoc).toContain("separate process");
    expect(watchdogDoc).toContain("Supersession");
    expect(runbook).toContain("COMPOSE_PROFILES=otel");
    expect(runbook).toContain("QUASAR_OTLP_BASE_URL=http://otel-lgtm:4318");
  });

  test("runbook documents the agent-facing server tool contract", () => {
    const cli = readFileSync(join(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    const clientConfig = readFileSync(join(repoRoot, "packages/cli/src/client-config.ts"), "utf8");
    const runbook = readFileSync(join(repoRoot, "docs/operations/server-docker-tailscale.md"), "utf8");

    expect(cli).toContain("tool-calls [--session id] [--project key] [--provider name[,name]]");
    expect(cli).toContain("tool-call --id id");
    expect(cli).toContain("[--role user|assistant|reasoning]");
    expect(cli).toContain("daemon install --server https://<quasar-service-tailnet-hostname> --ingest-token <token> [--interval-seconds 60]");
    expect(cli).toContain("com.quasar.remote-ingest");
    expect(cli).toContain("already_running");
    expect(cli).toContain("config.json");
    expect(clientConfig).toContain("serverUrl");
    expect(clientConfig).toContain("ingestToken");
    expect(runbook).toContain("Agent / MCP serving contract");
    expect(runbook).toContain("GET /search/{mode}");
    expect(runbook).toContain("remote write ingest fails closed before provider scanning");
    expect(runbook).toContain("nextOffset");
    expect(runbook).toContain("body-free summaries");
    expect(runbook).toContain("Operator-only commands");
  });
});
