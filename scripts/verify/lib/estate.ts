/**
 * Live-estate access for the validation batteries.
 *
 * Read-only: every call here is a Convex query against the pinned self-hosted
 * backend. The batteries never mutate the ingested estate.
 */
import { ConvexHttpClient } from "convex/browser";

export interface EstateSession {
  readonly sessionId: string;
  readonly provider: string;
  readonly projectKey: string;
  readonly sourcePath: string;
  readonly messageCount: number;
  readonly toolCallCount: number;
  readonly title?: string;
}

export interface EstateMessage {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: "user" | "assistant" | "reasoning";
  readonly text: string;
  readonly projectKey: string;
}

export const convexClient = (): ConvexHttpClient => {
  const url = process.env.CONVEX_SELF_HOSTED_URL ?? process.env.CONVEX_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      "Convex backend URL not found: set CONVEX_SELF_HOSTED_URL or CONVEX_URL (bun auto-loads .env.local from the repository root).",
    );
  }
  return new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true });
};

/** Full paginated walk: every session row in the estate (listProjects → listSessions). */
export const walkEstateSessions = async (
  client: ConvexHttpClient,
): Promise<EstateSession[]> => {
  const projects = (await client.query("quasar:listProjects" as never, {})) as {
    projectKey: string;
  }[];
  const sessions: EstateSession[] = [];
  for (const project of projects) {
    let cursor: string | null = null;
    do {
      const result = (await client.query("quasar:listSessions" as never, {
        projectKey: project.projectKey,
        paginationOpts: { numItems: 500, cursor },
      })) as { page: EstateSession[]; isDone: boolean; continueCursor: string };
      sessions.push(...result.page);
      cursor = result.isDone ? null : result.continueCursor;
    } while (cursor !== null);
  }
  return sessions;
};

/** Page readSession to completion for one session, in seq order. */
export const readSessionMessages = async (
  client: ConvexHttpClient,
  sessionId: string,
): Promise<EstateMessage[]> => {
  const messages: EstateMessage[] = [];
  let cursor: string | null = null;
  do {
    const result = (await client.query("quasar:readSession" as never, {
      sessionId,
      paginationOpts: { numItems: 200, cursor },
    })) as { page: EstateMessage[]; isDone: boolean; continueCursor: string };
    messages.push(...result.page);
    cursor = result.isDone ? null : result.continueCursor;
  } while (cursor !== null);
  return messages;
};

export interface SearchHit {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly text: string;
  readonly projectKey: string;
}

export const searchMessages = async (
  client: ConvexHttpClient,
  args: { query: string; projectKey?: string; role?: string; limit?: number },
): Promise<SearchHit[]> =>
  (await client.query("quasar:searchMessages" as never, args as never)) as SearchHit[];
