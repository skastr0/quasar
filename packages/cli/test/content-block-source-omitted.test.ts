import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeMappedSessionSync,
  decodeNormalizedSessionSync,
} from "@skastr0/quasar-protocol";

import { ampAdapter, type AmpRunner, type AmpStreamOptions } from "../src/adapters/amp";
import { contentBlocksFromNative } from "../src/adapters/common";
import type { ContentBlock, NormalizedSession } from "../src/core/schemas";
import { mapSession } from "../src/map";
import {
  adapterFor,
  appendText,
  buildFixtureFor,
  rewriteCursorFixtureUserMessage,
  type AdapterFixture,
  type AdapterProvider,
} from "./adapter-test-harness";

/**
 * Class 2 of the live ingest failure classes: a provider names an image or a
 * file whose bytes are inline-only, so the emitted content block carries
 * neither `path` nor `uri` and the whole session fails to decode.
 *
 * Every fixture below is the provider-native input measured from the local
 * corpus (see fixtures/hostile/README.md). The obligation is the same for all
 * of them: the session is ADMITTED, the block is PRESENT, and it carries the
 * explicit source-omitted marker. Never a session rejection.
 */
const HOSTILE_DIR = join(import.meta.dir, "fixtures", "hostile");

const readHostileText = (name: string) =>
  readFileSync(join(HOSTILE_DIR, name), "utf8");

const readHostileJson = (name: string) =>
  JSON.parse(readHostileText(name)) as Record<string, unknown>;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const withFixture = (provider: AdapterProvider) => {
  const root = mkdtempSync(join(tmpdir(), `quasar-${provider}-sourceomitted-`));
  tempRoots.push(root);
  return buildFixtureFor(provider, root);
};

const readProvider = async (provider: AdapterProvider, fixture: AdapterFixture) =>
  adapterFor(provider).read({
    machine: { machineId: "machine:test", hostname: "test-host", platform: "darwin" },
    now: "2026-06-11T00:00:00.000Z",
    roots: { [provider]: fixture.root },
    logicalRoots: { [provider]: fixture.logicalRoot },
  });

const allBlocks = (sessions: readonly NormalizedSession[]): ContentBlock[] =>
  sessions.flatMap((session) => session.events.flatMap((event) => [...event.contentBlocks]));

/**
 * The whole-session obligation. Every session the adapter yielded must decode
 * against the strict protocol AND survive the mapped-session envelope — a
 * refinement-violating block fails either one, which is exactly the production
 * failure this guards.
 */
const expectSessionsAdmitted = (
  provider: AdapterProvider | "amp",
  sessions: readonly NormalizedSession[],
) => {
  expect(sessions.length).toBeGreaterThan(0);
  for (const session of sessions) {
    expect(() => decodeNormalizedSessionSync(session)).not.toThrow();
    expect(() =>
      decodeMappedSessionSync(mapSession(session, `fixture:${provider}`))).not.toThrow();
  }
};

const expectSourceOmitted = (
  block: ContentBlock | undefined,
  expected: { readonly kind: "image" | "file"; readonly mediaType?: string },
) => {
  expect(block).toBeDefined();
  expect(block!.kind).toBe(expected.kind);
  expect(block!.sourceOmitted).toBe(true);
  expect(block!.path).toBeUndefined();
  expect(block!.uri).toBeUndefined();
  if (expected.mediaType !== undefined) {
    expect(block!.mediaType).toBe(expected.mediaType);
  }
};

describe("class 2: source-omitted image and file content blocks", () => {
  test("claude: a base64 image block whose source is stripped is admitted with the marker", async () => {
    const fixture = withFixture("claude");
    appendText(fixture.primaryPath, readHostileText("claude-image-block-source-stripped.jsonl"));
    const result = await readProvider("claude", fixture);

    expectSessionsAdmitted("claude", result.sessions);
    const block = allBlocks(result.sessions).find((candidate) => candidate.kind === "image");
    expectSourceOmitted(block, { kind: "image", mediaType: "image/png" });
    // Provenance the provider stated: the byte length of the source it dropped.
    expect(block!.sourceBytes).toBe(22);
  }, 15_000);

  test("claude: a base64 file block with no file_path is admitted with the marker", async () => {
    const fixture = withFixture("claude");
    appendText(fixture.primaryPath, readHostileText("claude-file-block-no-path.jsonl"));
    const result = await readProvider("claude", fixture);

    expectSessionsAdmitted("claude", result.sessions);
    const block = allBlocks(result.sessions).find((candidate) => candidate.kind === "file");
    expectSourceOmitted(block, { kind: "file", mediaType: "application/pdf" });
  }, 15_000);

  test("grok: a tool_call_update carrying inline image data is admitted with the marker", async () => {
    const fixture = withFixture("grok");
    writeFileSync(
      join(dirname(fixture.primaryPath), "updates.jsonl"),
      readHostileText("grok-tool-call-update-image-data.jsonl"),
      "utf8",
    );
    const result = await readProvider("grok", fixture);

    expectSessionsAdmitted("grok", result.sessions);
    expectSourceOmitted(
      allBlocks(result.sessions).find((candidate) => candidate.kind === "image"),
      { kind: "image", mediaType: "image/jpeg" },
    );
  }, 15_000);

  test("pi: an inline {data, mimeType} image is admitted with the marker", async () => {
    const fixture = withFixture("pi");
    appendText(fixture.primaryPath, readHostileText("pi-image-content-data-mime.jsonl"));
    const result = await readProvider("pi", fixture);

    expectSessionsAdmitted("pi", result.sessions);
    const block = allBlocks(result.sessions).find((candidate) => candidate.kind === "image");
    expectSourceOmitted(block, { kind: "image", mediaType: "image/jpeg" });
    expect(block!.sourceBytes).toBe(22);
  }, 15_000);

  test("prime: an inline {data, mimeType} image is admitted with the marker", async () => {
    const fixture = withFixture("prime");
    appendText(fixture.primaryPath, readHostileText("prime-image-content-data-mime.jsonl"));
    const result = await readProvider("prime", fixture);

    expectSessionsAdmitted("prime", result.sessions);
    const block = allBlocks(result.sessions).find((candidate) => candidate.kind === "image");
    expectSourceOmitted(block, { kind: "image", mediaType: "image/jpeg" });
    expect(block!.sourceBytes).toBe(22);
  }, 15_000);

  test("cursor: a hex-buffer image block is admitted with the marker", async () => {
    const fixture = withFixture("cursor");
    rewriteCursorFixtureUserMessage(fixture, readHostileJson("cursor-image-block-hex-buffer.json"));
    const result = await readProvider("cursor", fixture);

    expectSessionsAdmitted("cursor", result.sessions);
    const block = allBlocks(result.sessions).find((candidate) => candidate.kind === "image");
    // Cursor's on-disk spelling is `mimeType`; it must still reach the block.
    expectSourceOmitted(block, { kind: "image", mediaType: "image/jpeg" });
    expect(block!.value).toBeDefined();
    // The opaque marker kept the byte count; it is the only provenance an
    // omitted source can carry, so it must reach `sourceBytes` too.
    expect(block!.sourceBytes).toBe(8);
  }, 15_000);

  test("amp: a base64 image source with no url and no sourcePath is admitted with the marker", async () => {
    const thread = "T-image-0001";
    const exported = {
      v: 24,
      id: thread,
      title: "Image thread",
      created: 1_746_100_000_000,
      updatedAt: "2026-07-20T12:00:00.000Z",
      ...readHostileJson("amp-image-block-base64-source.json"),
    };
    const runner: AmpRunner = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "0.0.1\n" };
      if (args[0] === "threads" && args[1] === "list") {
        const offsetIndex = args.indexOf("--offset");
        const offset = offsetIndex >= 0 ? Number(args[offsetIndex + 1]) : 0;
        return {
          ok: true,
          stdout: JSON.stringify(offset === 0
            ? [{
                id: thread,
                title: "Image thread",
                updated: "2026-07-20T12:00:00.000Z",
                tree: "file:///synthetic/project",
                messageCount: 1,
              }]
            : []),
        };
      }
      if (args[0] === "threads" && args[1] === "export" && args[2] === thread) {
        return { ok: true, stdout: JSON.stringify(exported) };
      }
      return { ok: false, reason: "command_failed" };
    };

    const options: AmpStreamOptions = {
      machine: { machineId: "machine:test", hostname: "test-host", platform: "darwin" },
      now: "2026-07-24T12:00:00.000Z",
      ampRunner: runner,
      ampSleep: async () => {},
      exportSpacingMs: 0,
    };
    const result = await ampAdapter.read(options);

    expectSessionsAdmitted("amp", result.sessions);
    const block = allBlocks(result.sessions).find((candidate) => candidate.kind === "image");
    expectSourceOmitted(block, { kind: "image", mediaType: "image/png" });
    expect(block!.sourceBytes).toBe(22);
  }, 15_000);

  test("claude: a `url` image source is LOCATED, never marked source-omitted", async () => {
    const fixture = withFixture("claude");
    appendText(fixture.primaryPath, readHostileText("claude-image-block-url-source.jsonl"));
    const result = await readProvider("claude", fixture);

    expectSessionsAdmitted("claude", result.sessions);
    const block = allBlocks(result.sessions).find((candidate) => candidate.kind === "image");
    expect(block).toBeDefined();
    // The marker asserts the provider supplied NO retrievable source. Anthropic
    // supplied one; claiming otherwise would be a false attribution.
    expect(block!.sourceOmitted).toBeUndefined();
    expect(block!.uri).toBe("https://synthetic.invalid/shot.png");
    expect(block!.mediaType).toBe("image/png");
  }, 15_000);

  test("a nested locator container is unwrapped, never marked source-omitted", () => {
    const sessionId = "session:synthetic" as unknown as Parameters<typeof contentBlocksFromNative>[0];
    const located = (native: unknown) => {
      const blocks = contentBlocksFromNative(sessionId, "event:synthetic", [native]);
      expect(blocks).toHaveLength(1);
      return blocks[0]!;
    };

    // OpenAI: `image_url` is a container, not a string.
    const openAi = located({ type: "image_url", image_url: { url: "https://synthetic.invalid/a.png" } });
    expect(openAi.uri).toBe("https://synthetic.invalid/a.png");
    expect(openAi.sourceOmitted).toBeUndefined();

    // Anthropic: the locator lives on `source`.
    const anthropic = located({
      type: "image",
      source: { type: "url", url: "https://synthetic.invalid/b.png", media_type: "image/png" },
    });
    expect(anthropic.uri).toBe("https://synthetic.invalid/b.png");
    expect(anthropic.mediaType).toBe("image/png");
    expect(anthropic.sourceOmitted).toBeUndefined();

    // `file` is the same shape: the container that decides `kind: "file"` also
    // carries the path.
    const file = located({ type: "file", file: { path: "/synthetic/report.txt" } });
    expect(file.path).toBe("/synthetic/report.txt");
    expect(file.sourceOmitted).toBeUndefined();

    // A container with no locator still yields the honest marker.
    const inlineOnly = located({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(inlineOnly.sourceOmitted).toBe(true);
    expect(inlineOnly.mediaType).toBe("image/png");
  });

  test("a located block is untouched: path and uri survive, no marker appears", async () => {
    const fixture = withFixture("cursor");
    rewriteCursorFixtureUserMessage(fixture, {
      role: "user",
      content: [
        {
          type: "image",
          uri: "https://example.test/synthetic.png",
          mediaType: "image/png",
        },
        {
          type: "file",
          filename: "/synthetic/report.pdf",
          mediaType: "application/pdf",
        },
      ],
    });
    const result = await readProvider("cursor", fixture);

    expectSessionsAdmitted("cursor", result.sessions);
    const blocks = allBlocks(result.sessions);
    const image = blocks.find((candidate) => candidate.kind === "image");
    expect(image?.uri).toBe("https://example.test/synthetic.png");
    expect(image?.mediaType).toBe("image/png");
    expect(image?.sourceOmitted).toBeUndefined();
    const file = blocks.find((candidate) => candidate.kind === "file");
    expect(file?.path).toBe("/synthetic/report.pdf");
    expect(file?.sourceOmitted).toBeUndefined();
  }, 15_000);
});
