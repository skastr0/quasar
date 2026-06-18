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
});
