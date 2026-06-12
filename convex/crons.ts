import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Safety net for already-ingested sessions and any failed/canceled work whose
// claim was cleared by the Workpool completion handler. Normal fresh ingest
// schedules embedding directly from commitSessionIngest.
crons.interval(
  "schedule pending embeddings",
  { minutes: 5 },
  internal.embed.scheduleEmbeddingBackfill,
  { limit: 100 },
);

export default crons;
