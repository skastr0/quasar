import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  ensureAuthorized,
  ensureJsonRequest,
  ensureStrictTokenAuthorized,
} from "./httpAuth.js";
import { quasarApiPaths } from "./quasarApiPaths";
import { serverEmbeddingsConfigured } from "./quasarRag";

const http = httpRouter();

const corsHeaders = () => ({
  "access-control-allow-origin": process.env.QUASAR_ALLOWED_ORIGIN ?? "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });

const withCors = async (response: Response) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
  return new Response(await response.text(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const preflight = () =>
  new Response(null, {
    status: 204,
    headers: { ...corsHeaders(), "access-control-max-age": "86400" },
  });

const readJson = async (req: Request): Promise<unknown> => {
  const text = await req.text();
  return text.trim().length === 0 ? {} : JSON.parse(text);
};

const providerValues = new Set([
  "codex",
  "claude",
  "opencode",
  "grok",
  "amp",
  "pi",
  "kimi",
  "droid",
  "hermes",
  "antigravity",
  "cursor",
  "gemini",
  "unknown",
]);

const optionalSearchParam = (url: URL, key: string) =>
  url.searchParams.get(key) ?? undefined;

const optionalNumberParam = (url: URL, key: string) => {
  const value = url.searchParams.get(key);
  if (value === null || value.trim().length === 0) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const optionalProviderParam = (url: URL) => {
  const value = optionalSearchParam(url, "provider");
  if (value === undefined) return undefined;
  if (!providerValues.has(value)) throw new Error("provider must be a supported provider.");
  return value as never;
};

const handle = (fn: (ctx: ActionCtx, req: Request) => Promise<Response>) =>
  httpAction(async (ctx, req) => {
    try {
      ensureAuthorized(req);
      return await fn(ctx, req);
    } catch (error) {
      if (error instanceof Response) return await withCors(error);
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

const handleMutation = (fn: (ctx: ActionCtx, req: Request) => Promise<Response>) =>
  httpAction(async (ctx, req) => {
    try {
      ensureStrictTokenAuthorized(req);
      ensureJsonRequest(req);
      return await fn(ctx, req);
    } catch (error) {
      if (error instanceof Response) return await withCors(error);
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

for (const path of [
  quasarApiPaths.ingestBatches,
  quasarApiPaths.ingestJobs,
  quasarApiPaths.ingestJobChunks,
  quasarApiPaths.ingestJobChunksBulk,
  quasarApiPaths.embeddingControl,
  "/api/projects",
  "/api/projects/alias",
  "/api/sessions",
  "/api/sessions/read",
  "/api/search/text",
  "/api/search/semantic",
  "/api/search/fusion",
  "/api/tool-calls",
  "/api/import-runs",
  "/api/capabilities",
  "/api/health",
]) {
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async () => preflight()),
  });
}

http.route({
  path: "/api/health",
  method: "GET",
  handler: handle(async () =>
    json({
      ok: true,
      service: "quasar-control",
      embeddingsConfigured: serverEmbeddingsConfigured(),
    }),
  ),
});

http.route({
  path: "/api/capabilities",
  method: "GET",
  handler: handle(async () =>
    json({
      protocolVersion: "quasar-api/v1",
      ingestion: {
        batch: true,
        jobs: true,
        idempotent: true,
        nativeHistoryWrites: false,
      },
      search: {
        text: true,
        semantic: true,
        fusion: true,
        embeddingDimensions: 1536,
        serverEmbeddingsConfigured: serverEmbeddingsConfigured(),
        acceptsClientEmbeddings: false,
      },
    }),
  ),
});

http.route({
  path: quasarApiPaths.ingestJobs,
  method: "POST",
  handler: handleMutation(async (ctx, req) =>
    json(
      await ctx.runMutation(internal.quasar.startImportJobInternal, {
        input: await readJson(req),
      }),
    ),
  ),
});

http.route({
  path: quasarApiPaths.ingestJobs,
  method: "GET",
  handler: handle(async (ctx, req) => {
    const url = new URL(req.url);
    const importJobId = url.searchParams.get("importJobId");
    if (importJobId === null) {
      return json(
        await ctx.runQuery(internal.quasar.listImportJobsInternal, {
          limit: optionalNumberParam(url, "limit"),
        }),
      );
    }
    const job = await ctx.runQuery(internal.quasar.readImportJobInternal, {
      input: {
        importJobId,
        chunkCursor: url.searchParams.get("chunkCursor"),
        failureCursor: url.searchParams.get("failureCursor"),
        limit: optionalNumberParam(url, "limit"),
      },
    });
    return job === null ? json({ error: "not found" }, 404) : json(job);
  }),
});

http.route({
  path: quasarApiPaths.ingestJobChunks,
  method: "POST",
  handler: handleMutation(async (ctx, req) =>
    json(
      await ctx.runAction(internal.quasar.submitImportChunkInternal, {
        input: await readJson(req),
      }),
    ),
  ),
});

http.route({
  path: quasarApiPaths.ingestJobChunksBulk,
  method: "POST",
  handler: handleMutation(async (ctx, req) =>
    json(
      await ctx.runAction(internal.quasar.submitImportChunksInternal, {
        input: await readJson(req),
      }),
    ),
  ),
});

http.route({
  path: quasarApiPaths.embeddingControl,
  method: "GET",
  handler: handle(async (ctx) =>
    json({
      control: await ctx.runQuery(internal.quasar.readEmbeddingControlInternal, {}),
      readiness: await ctx.runQuery(internal.quasar.embeddingReadinessInternal, {}),
    }),
  ),
});

http.route({
  path: quasarApiPaths.embeddingControl,
  method: "POST",
  handler: handleMutation(async (ctx, req) => {
    const body = (await readJson(req)) as Record<string, unknown>;
    const control = await ctx.runMutation(internal.quasar.setEmbeddingControlInternal, {
      input: body,
    });
    const retried =
      body.retryFailed === true
        ? await ctx.runMutation(internal.quasar.retryFailedEmbeddingOutboxInternal, {
            limit: typeof body.limit === "number" ? body.limit : undefined,
          })
        : undefined;
    const rebuilt =
      body.rebuildPending === true
        ? await ctx.runMutation(internal.quasar.rebuildEmbeddingBackfillInternal, {
            projectIdentityKey:
              typeof body.projectIdentityKey === "string" ? body.projectIdentityKey : undefined,
            limit: typeof body.limit === "number" ? body.limit : undefined,
          })
        : undefined;
    return json({ control, retried, rebuilt });
  }),
});

http.route({
  path: quasarApiPaths.ingestBatches,
  method: "POST",
  handler: handleMutation(async (ctx, req) =>
    json(
      await ctx.runMutation(internal.quasar.ingestBatchInternal, {
        batch: await readJson(req),
      }),
    ),
  ),
});

http.route({
  path: "/api/projects",
  method: "GET",
  handler: handle(async (ctx, req) => {
    const url = new URL(req.url);
    return json(
      await ctx.runQuery(internal.quasar.listProjectsInternal, {
        cursor: url.searchParams.get("cursor"),
        limit: optionalNumberParam(url, "limit"),
      }),
    );
  }),
});

http.route({
  path: "/api/projects/alias",
  method: "POST",
  handler: handleMutation(async (ctx, req) => {
    const body = (await readJson(req)) as Record<string, unknown>;
    return json(
      await ctx.runMutation(internal.quasar.aliasProjectInternal, {
        sourceProjectIdentityKey: String(body.sourceProjectIdentityKey ?? ""),
        targetProjectIdentityKey: String(body.targetProjectIdentityKey ?? ""),
        reason: typeof body.reason === "string" ? body.reason : undefined,
      }),
    );
  }),
});

http.route({
  path: "/api/sessions",
  method: "GET",
  handler: handle(async (ctx, req) => {
    const url = new URL(req.url);
    return json(
      await ctx.runQuery(internal.quasar.listSessionsInternal, {
        projectIdentityKey: url.searchParams.get("projectIdentityKey") ?? undefined,
        machineId: url.searchParams.get("machineId") ?? undefined,
        provider: (url.searchParams.get("provider") as never) ?? undefined,
        agentName: url.searchParams.get("agentName") ?? undefined,
        cursor: url.searchParams.get("cursor"),
        limit: optionalNumberParam(url, "limit"),
      }),
    );
  }),
});

http.route({
  path: "/api/sessions",
  method: "POST",
  handler: handle(async (ctx, req) =>
    json(await ctx.runQuery(internal.quasar.listSessionsInternal, (await readJson(req)) as never)),
  ),
});

http.route({
  path: "/api/sessions/read",
  method: "GET",
  handler: handle(async (ctx, req) => {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId === null) return json({ error: "sessionId is required" }, 400);
    const session = await ctx.runQuery(internal.quasar.readSessionInternal, {
      sessionId,
      view: (url.searchParams.get("view") as never) ?? undefined,
      leafEventId: url.searchParams.get("leafEventId") ?? undefined,
      eventCursor: url.searchParams.get("eventCursor"),
      contentBlockCursor: url.searchParams.get("contentBlockCursor"),
      toolCallCursor: url.searchParams.get("toolCallCursor"),
      edgeCursor: url.searchParams.get("edgeCursor"),
      usageCursor: url.searchParams.get("usageCursor"),
      artifactCursor: url.searchParams.get("artifactCursor"),
      limit: optionalNumberParam(url, "limit"),
    });
    return session === null ? json({ error: "not found" }, 404) : json(session);
  }),
});

http.route({
  path: "/api/sessions/read",
  method: "POST",
  handler: handle(async (ctx, req) => {
    const body = (await readJson(req)) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    if (sessionId === undefined) return json({ error: "sessionId is required" }, 400);
    const session = await ctx.runQuery(internal.quasar.readSessionInternal, {
      sessionId,
      view: (body.view as never) ?? undefined,
      leafEventId: typeof body.leafEventId === "string" ? body.leafEventId : undefined,
      eventCursor: typeof body.eventCursor === "string" ? body.eventCursor : undefined,
      contentBlockCursor: typeof body.contentBlockCursor === "string" ? body.contentBlockCursor : undefined,
      toolCallCursor: typeof body.toolCallCursor === "string" ? body.toolCallCursor : undefined,
      edgeCursor: typeof body.edgeCursor === "string" ? body.edgeCursor : undefined,
      usageCursor: typeof body.usageCursor === "string" ? body.usageCursor : undefined,
      artifactCursor: typeof body.artifactCursor === "string" ? body.artifactCursor : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    });
    return session === null ? json({ error: "not found" }, 404) : json(session);
  }),
});

const rejectClientEmbedding = (body: unknown) =>
  body !== null && typeof body === "object" && "embedding" in body
    ? json(
        {
          error:
            "Client-supplied search embeddings are not accepted. Send query text; Quasar generates embeddings server-side.",
        },
        400,
      )
    : undefined;

http.route({
  path: "/api/search/text",
  method: "GET",
  handler: handle(async (ctx, req) => {
    const url = new URL(req.url);
    const query = url.searchParams.get("query") ?? url.searchParams.get("q");
    if (query === null) return json({ error: "query is required" }, 400);
    return json(
      await ctx.runQuery(internal.quasar.textSearchInternal, {
        query,
        projectIdentityKey: url.searchParams.get("projectIdentityKey") ?? undefined,
        machineId: url.searchParams.get("machineId") ?? undefined,
        provider: (url.searchParams.get("provider") as never) ?? undefined,
        agentName: url.searchParams.get("agentName") ?? undefined,
        role: (url.searchParams.get("role") as never) ?? undefined,
        kind: (url.searchParams.get("kind") as never) ?? undefined,
        toolName: url.searchParams.get("toolName") ?? undefined,
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
        limit: optionalNumberParam(url, "limit"),
      }),
    );
  }),
});

http.route({
  path: "/api/search/text",
  method: "POST",
  handler: handle(async (ctx, req) =>
    json(await ctx.runQuery(internal.quasar.textSearchInternal, (await readJson(req)) as never)),
  ),
});

http.route({
  path: "/api/search/semantic",
  method: "POST",
  handler: handle(async (ctx, req) => {
    const body = await readJson(req);
    const rejected = rejectClientEmbedding(body);
    if (rejected !== undefined) return rejected;
    return json(await ctx.runAction(internal.quasar.semanticSearchInternal, body as never));
  }),
});

http.route({
  path: "/api/search/fusion",
  method: "POST",
  handler: handle(async (ctx, req) => {
    const body = await readJson(req);
    const rejected = rejectClientEmbedding(body);
    if (rejected !== undefined) return rejected;
    return json(await ctx.runAction(internal.quasar.fusionSearchInternal, body as never));
  }),
});

http.route({
  path: "/api/tool-calls",
  method: "GET",
  handler: handle(async (ctx, req) => {
    const url = new URL(req.url);
    return json(
      await ctx.runQuery(internal.quasar.listToolCallsInternal, {
        toolCallId: optionalSearchParam(url, "toolCallId"),
        sessionId: optionalSearchParam(url, "sessionId"),
        projectIdentityKey: optionalSearchParam(url, "projectIdentityKey"),
        machineId: optionalSearchParam(url, "machineId"),
        provider: optionalProviderParam(url),
        agentName: optionalSearchParam(url, "agentName"),
        toolName: optionalSearchParam(url, "toolName"),
        cursor: url.searchParams.get("cursor"),
        limit: optionalNumberParam(url, "limit"),
      }),
    );
  }),
});

http.route({
  path: "/api/tool-calls",
  method: "POST",
  handler: handle(async (ctx, req) =>
    json(await ctx.runQuery(internal.quasar.listToolCallsInternal, (await readJson(req)) as never)),
  ),
});

http.route({
  path: "/api/import-runs",
  method: "GET",
  handler: handle(async (ctx) => json(await ctx.runQuery(internal.quasar.listImportRunsInternal, {}))),
});

export default http;
