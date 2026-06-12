import { defineApp } from "convex/server";
import rag from "@convex-dev/rag/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";

// The RAG component owns the embedding store (entries, chunks, vector index)
// and its internal scheduling. Quasar owns one separate Workpool for throttled
// ingest-triggered embedding jobs; clients never trigger embedding directly.
const app: ReturnType<typeof defineApp> = defineApp();
app.use(rag);
app.use(workpool, { name: "embeddingWorkpool" });

export default app;
