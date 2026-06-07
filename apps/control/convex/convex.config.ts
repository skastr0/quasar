import { defineApp } from "convex/server";
import migrations from "@convex-dev/migrations/convex.config.js";
import rag from "@convex-dev/rag/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";

const app: ReturnType<typeof defineApp> = defineApp();
app.use(migrations);
app.use(rag);
app.use(workpool);

export default app;
