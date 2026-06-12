import { defineApp } from "convex/server";
import rag from "@convex-dev/rag/convex.config.js";

// The RAG component owns the embedding store (entries, chunks, vector index)
// and its internal Workpool scheduling — adopted wholesale per the platform
// rulings; no app-level job system is mounted alongside it.
const app: ReturnType<typeof defineApp> = defineApp();
app.use(rag);

export default app;
