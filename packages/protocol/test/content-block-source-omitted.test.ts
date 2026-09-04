import { describe, expect, test } from "bun:test";
import {
  decodeNormalizedSessionSync,
  protocolContracts,
} from "../src/index";

/**
 * The source-omitted marker on image/file content blocks. Three obligations:
 * the marker admits a block a provider named without a retrievable source, the
 * refinement stays strict for every other shape, and the change is additive —
 * a payload written before the marker existed decodes exactly as it did.
 */
describe("content block source-omitted marker", () => {
  const sourceExample = (): any =>
    structuredClone(protocolContracts.normalizedSession.examples[0].input);

  const withBlock = (block: unknown) => {
    const session = sourceExample();
    session.events[0] = {
      ...session.events[0],
      contentBlocks: [block],
    };
    session.contentBlockCount = 1;
    return session;
  };

  const decodedBlock = (block: unknown) =>
    decodeNormalizedSessionSync(withBlock(block)).events[0]!.contentBlocks[0]!;

  for (const kind of ["image", "file"] as const) {
    test(`kind=${kind} with a path decodes unchanged and never gains a marker`, () => {
      const input = {
        id: "block-located",
        sequence: 0,
        kind,
        path: "/synthetic/asset.bin",
        mediaType: "application/octet-stream",
      };
      const block = decodedBlock(input);
      expect(block).toEqual(input);
      expect("sourceOmitted" in block).toBe(false);
    });

    test(`kind=${kind} with a uri decodes unchanged`, () => {
      const input = {
        id: "block-uri",
        sequence: 0,
        kind,
        uri: "https://example.test/synthetic",
      };
      expect(decodedBlock(input)).toEqual(input);
    });

    test(`kind=${kind} with the marker is admitted and carries its provenance`, () => {
      const input = {
        id: "block-omitted",
        sequence: 0,
        kind,
        sourceOmitted: true as const,
        mediaType: "image/png",
        sourceBytes: 21,
      };
      expect(decodedBlock(input)).toEqual(input);
    });

    test(`kind=${kind} with neither a locator nor the marker still fails closed`, () => {
      expect(() =>
        decodeNormalizedSessionSync(withBlock({
          id: "block-unsourced",
          sequence: 0,
          kind,
          mediaType: "image/png",
        }))).toThrow();
    });

    test(`kind=${kind} may not claim omission and a locator at once`, () => {
      expect(() =>
        decodeNormalizedSessionSync(withBlock({
          id: "block-contradiction",
          sequence: 0,
          kind,
          path: "/synthetic/asset.bin",
          sourceOmitted: true,
        }))).toThrow();
      expect(() =>
        decodeNormalizedSessionSync(withBlock({
          id: "block-contradiction-uri",
          sequence: 0,
          kind,
          uri: "https://example.test/synthetic",
          sourceOmitted: true,
        }))).toThrow();
    });

    test(`kind=${kind} rejects sourceOmitted values other than true`, () => {
      for (const value of [false, "true", 1, null]) {
        expect(() =>
          decodeNormalizedSessionSync(withBlock({
            id: "block-marker-shape",
            sequence: 0,
            kind,
            sourceOmitted: value,
          }))).toThrow();
      }
    });
  }

  test("non-media kinds may not carry the marker or its provenance", () => {
    expect(() =>
      decodeNormalizedSessionSync(withBlock({
        id: "block-text-marker",
        sequence: 0,
        kind: "text",
        text: "synthetic turn",
        sourceOmitted: true,
      }))).toThrow();
    expect(() =>
      decodeNormalizedSessionSync(withBlock({
        id: "block-json-bytes",
        sequence: 0,
        kind: "json",
        value: { synthetic: true },
        sourceBytes: 4,
      }))).toThrow();
  });

  test("the marker is additive: a pre-change corpus sample decodes byte-identically", () => {
    // Every content-block shape that was valid before the marker existed.
    const preChangeBlocks = [
      { id: "b0", sequence: 0, kind: "text", text: "synthetic turn" },
      { id: "b1", sequence: 1, kind: "markdown", markdown: "# synthetic" },
      { id: "b2", sequence: 2, kind: "thinking", thinking: "synthetic" },
      {
        id: "b3",
        sequence: 3,
        kind: "image",
        path: "/synthetic/shot.png",
        mediaType: "image/png",
      },
      {
        id: "b4",
        sequence: 4,
        kind: "image",
        uri: "https://example.test/shot.png",
      },
      {
        id: "b5",
        sequence: 5,
        kind: "file",
        path: "/synthetic/report.pdf",
        mediaType: "application/pdf",
        metadata: { nativeType: "document" },
      },
      { id: "b6", sequence: 6, kind: "json", value: { synthetic: true } },
    ];
    const session = sourceExample();
    session.events[0] = {
      ...session.events[0],
      contentBlocks: preChangeBlocks,
    };
    session.contentBlockCount = preChangeBlocks.length;
    const decoded = decodeNormalizedSessionSync(session);
    expect(decoded.events[0]!.contentBlocks).toEqual(preChangeBlocks as never);
    expect(
      decoded.events[0]!.contentBlocks.some((block) =>
        "sourceOmitted" in block || "sourceBytes" in block
      ),
    ).toBe(false);
  });
});
