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
    expect(pkg).toContain("local-server:maintain");
    expect(pkg).toContain("local-server:lance");
    expect(pkg).toContain("local-server:backup");
    expect(ops).toContain("case \"syncTick\"");
    expect(ops).toContain("case \"maintain\"");
    expect(ops).toContain("case \"lance\"");
    expect(ops).toContain("@lancedb/lancedb");
    expect(ops).toContain("VACUUM INTO");
    expect(ops).toContain("quasar-truth-backup.tar");
    expect(ops).toContain("bun packages/local-server/src/cli.ts ingest --provider all");
    expect(runbook).toContain("every 15 minutes: `bun run local-server:sync-tick`");
    expect(runbook).toContain("Avoid the HTTP maintenance endpoint for long optimize runs");
    expect(runbook).toContain("bun run local-server:lance");
    expect(runbook).toContain("does **not** archive `search.lance` by default");
  });
});
