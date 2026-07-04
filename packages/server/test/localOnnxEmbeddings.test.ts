import { describe, expect, test } from "bun:test";

import { makeEmbeddingProfile } from "../src/embeddingProfiles";
import { makeLocalOnnxEmbedder } from "../src/localOnnxEmbeddings";

describe("local ONNX embeddings", () => {
  test("embeds a batch with mean pooling and normalization options", async () => {
    const seen: unknown[] = [];
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      task: "search_document",
    });
    const embedder = makeLocalOnnxEmbedder(profile, {
      pipelineFactory: async () => async (values, options) => {
        seen.push({ values, options });
        return {
          dims: [2, 3],
          data: new Float32Array([1, 0, 0, 0, 1, 0]),
        };
      },
    });

    const vectors = await embedder.embedMany(["search_document: alpha", "search_document: beta"]);

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(seen).toEqual([{
      values: ["search_document: alpha", "search_document: beta"],
      options: { pooling: "mean", normalize: true },
    }]);
  });

  test("truncates and renormalizes Nomic v1.5 vectors for smaller configured dimensions", async () => {
    const profile = makeEmbeddingProfile({
      model: "nomic-ai/nomic-embed-text-v1.5",
      dimensions: 2,
      task: "search_document",
    });
    const embedder = makeLocalOnnxEmbedder(profile, {
      pipelineFactory: async () => async () => ({
        dims: [1, 3],
        data: new Float32Array([3, 4, 12]),
      }),
    });

    const [vector] = await embedder.embedMany(["search_document: alpha"]);

    expect(vector).toEqual([0.6, 0.8]);
  });

  test("retries pipeline loading after a transient failure", async () => {
    let attempts = 0;
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      task: "search_document",
    });
    const embedder = makeLocalOnnxEmbedder(profile, {
      pipelineFactory: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient model cache failure");
        }
        return async () => ({
          dims: [1, 3],
          data: new Float32Array([1, 0, 0]),
        });
      },
    });

    await expect(embedder.embedMany(["alpha"])).rejects.toThrow("transient model cache failure");
    await expect(embedder.embedMany(["alpha"])).resolves.toEqual([[1, 0, 0]]);
    expect(attempts).toBe(2);
  });

  test("rejects incompatible dimensions for non-Nomic models", async () => {
    const profile = makeEmbeddingProfile({
      model: "other-model",
      dimensions: 2,
      task: "search_document",
    });
    const embedder = makeLocalOnnxEmbedder(profile, {
      pipelineFactory: async () => async () => ({
        dims: [1, 3],
        data: new Float32Array([1, 0, 0]),
      }),
    });

    await expect(embedder.embedMany(["alpha"]))
      .rejects.toThrow("local ONNX embedding vector has dimension 3; expected 2");
  });
});
