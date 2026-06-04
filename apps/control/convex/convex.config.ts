import { defineApp } from "convex/server";
import migrations from "@convex-dev/migrations/convex.config.js";
import rag from "@convex-dev/rag/convex.config.js";

const app: ReturnType<typeof defineApp> = defineApp();
app.use(migrations);
app.use(rag);

export default app;
