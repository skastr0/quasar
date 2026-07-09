import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { stableAdapters } from "../src/adapters/registry";
import {
  adapterFor,
  buildFixtureFor,
  canonicalizeItems,
  collectStreamItems,
  type AdapterProvider,
} from "./adapter-test-harness";

const UPDATE_GOLDENS = process.env.QUASAR_UPDATE_ADAPTER_GOLDENS === "1";
const goldenPathFor = (provider: AdapterProvider) =>
  join(import.meta.dir, "fixtures", "goldens", `${provider}.adapter-stream.golden.json`);

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("adapter stream golden lock", () => {
  for (const { provider } of stableAdapters) {
    test(`${provider} full stream matches committed golden`, async () => {
      const root = mkdtempSync(join(tmpdir(), `quasar-${provider}-golden-`));
      tempRoots.push(root);
      const fixture = buildFixtureFor(provider, root);
      const actual = canonicalizeItems(await collectStreamItems(adapterFor(provider), fixture), fixture);
      const serialized = `${JSON.stringify(actual, null, 2)}\n`;
      const goldenPath = goldenPathFor(provider);

      if (UPDATE_GOLDENS) {
        mkdirSync(dirname(goldenPath), { recursive: true });
        writeFileSync(goldenPath, serialized, "utf8");
      }

      expect(existsSync(goldenPath)).toBe(true);
      expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
    }, 15_000);
  }
});
