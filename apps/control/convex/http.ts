import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  ensureAuthorized,
  ensureJsonRequest,
  ensureStrictTokenAuthorized,
} from "./httpAuth.js";
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
  "/api/ingest/batches",
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
  path: "/api/ingest/batches",
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
  handler: handle(async (ctx) => json(await ctx.runQuery(internal.quasar.listProjectsInternal, {}))),
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
        limit:
          url.searchParams.get("limit") === null
            ? undefined
            : Number(url.searchParams.get("limit")),
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
    const sessionId = new URL(req.url).searchParams.get("sessionId");
    if (sessionId === null) return json({ error: "sessionId is required" }, 400);
    const session = await ctx.runQuery(internal.quasar.readSessionInternal, { sessionId });
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
        limit:
          url.searchParams.get("limit") === null
            ? undefined
            : Number(url.searchParams.get("limit")),
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
        toolCallId: url.searchParams.get("toolCallId") ?? undefined,
        sessionId: url.searchParams.get("sessionId") ?? undefined,
        limit:
          url.searchParams.get("limit") === null
            ? undefined
            : Number(url.searchParams.get("limit")),
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
