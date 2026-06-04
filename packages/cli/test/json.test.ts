import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BunContext } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { loadJsonInput } from "../src/json";

const Input = Schema.Struct({
  provider: Schema.String,
  limit: Schema.Number,
});

let tempDir: string | undefined;

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect);

describe("JSON input loading", () => {
  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("decodes inline JSON", async () => {
    await expect(
      run(loadJsonInput(Input, '{"provider":"codex","limit":1}').pipe(Effect.provide(BunContext.layer))),
    ).resolves.toEqual({ provider: "codex", limit: 1 });
  });

  test("decodes @file JSON", async () => {
    tempDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "quasar-cli-"));
    const path = join(tempDir, "input.json");
    await writeFile(path, '{"provider":"codex","limit":2}', "utf8");

    await expect(
      run(loadJsonInput(Input, `@${path}`).pipe(Effect.provide(BunContext.layer))),
    ).resolves.toEqual({ provider: "codex", limit: 2 });
  });
});
