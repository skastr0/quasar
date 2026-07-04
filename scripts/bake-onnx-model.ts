#!/usr/bin/env bun
// Bakes the local query-side ONNX embedding model into a fixed cache
// directory at Docker BUILD time (not first-request runtime), so a fresh
// container never has to reach Hugging Face's CDN before it can serve a
// semantic query. Run once during `docker build`, with
// QUASAR_EMBEDDING_MODEL_CACHE_DIR pointed at a path baked into the image
// (never under the /data/quasar VOLUME, or an empty named volume would
// shadow it on first mount).
//
// Loads the SAME profile + dtype the production Embeddings layer loads at
// runtime (embeddingProfileFromEnv + the pinned QUERY_EMBEDDING_ONNX_DTYPE),
// so there is exactly one place that decides "which model, which dtype" —
// this script never re-states it.
import { embeddingProfileFromEnv } from "../packages/server/src/embeddingProfiles";
import { QUERY_EMBEDDING_ONNX_DTYPE } from "../packages/server/src/embeddings";
import { makeLocalOnnxEmbedder } from "../packages/server/src/localOnnxEmbeddings";

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event: `bake_onnx_model.${event}`, at: new Date().toISOString(), ...fields }));

const cacheDir = process.env.QUASAR_EMBEDDING_MODEL_CACHE_DIR?.trim();
if (cacheDir === undefined || cacheDir === "") {
  console.error(JSON.stringify({
    ok: false,
    error: "QUASAR_EMBEDDING_MODEL_CACHE_DIR must be set to a fixed, non-volume path before baking",
  }));
  process.exit(1);
}

const profile = embeddingProfileFromEnv();
log("start", { model: profile.model, dimensions: profile.dimensions, dtype: QUERY_EMBEDDING_ONNX_DTYPE, cacheDir });

const embedder = makeLocalOnnxEmbedder(profile, { dtype: QUERY_EMBEDDING_ONNX_DTYPE, cacheDir });
const started = performance.now();
try {
  const [vector] = await embedder.embedMany(["quasar docker image bake warmup"]);
  if (vector === undefined || vector.length !== profile.dimensions) {
    throw new Error(`bake warmup returned dimension ${vector?.length ?? "none"}; expected ${profile.dimensions}`);
  }
} catch (cause) {
  console.error(JSON.stringify({
    ok: false,
    error: "onnx model bake failed",
    detail: cause instanceof Error ? cause.message : String(cause),
  }));
  process.exit(1);
}
log("done", { elapsedMs: Math.round(performance.now() - started) });
