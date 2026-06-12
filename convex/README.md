# Quasar Convex App

Functions for the self-hosted Quasar backend.

- `schema.ts` — projects / sessions / messages (search surface) / toolCalls
  (structural surface; never search-indexed, never embedded).
- `quasar.ts` — ingest mutations (session-grain claims, delete-then-reinsert)
  and the serving queries (lexical search, session reads, tool-call walks).
- `convex.config.ts` — mounts the RAG component (Gemini embeddings store).
- `quasarRag.ts` — embedding model wiring (gemini-embedding-2, 1536 dims) and
  pure search shaping (RRF fusion, result mapping).
- `embed.ts` — the embedding pipeline over conversation rows (user/assistant
  only, pinned structurally) plus `searchSemantic` / `searchFusion` actions.

Batteries: `quasar.test.ts`, `consumption.test.ts`, `embed.test.ts` (vitest)
and `scripts/verify/convex-lint.ts` (grain rulings + embedding-surface purity).
