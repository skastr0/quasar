import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { api } from "../../../../convex/_generated/api";

import { createConvexClient, withRetry } from "../convex-client";
import { CommandInputError } from "../errors";
import { executeJsonCommand } from "../output";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const PAGE_SIZE = 100;

const limitOption = Options.integer("limit").pipe(
  Options.withDescription(`Maximum rows to return (1..${MAX_LIMIT})`),
  Options.optional,
);
const projectOption = Options.text("project").pipe(
  Options.withDescription("Restrict to one projectKey"),
  Options.optional,
);
const providerOption = Options.text("provider").pipe(
  Options.withDescription("Restrict to one provider"),
  Options.optional,
);
const toolNameOption = Options.text("tool-name").pipe(
  Options.withDescription("Restrict to one tool name"),
  Options.optional,
);
const sessionIdArg = Args.text({ name: "sessionId" });
const toolCallIdArg = Args.text({ name: "toolCallId" });

const checkedLimit = (value: Option.Option<number>): number => {
  const limit = Option.getOrElse(value, () => DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CommandInputError({
      field: "limit",
      message: `limit must be an integer in [1, ${MAX_LIMIT}], got ${limit}`,
    });
  }
  return limit;
};

const toolCallId = (row: { readonly sessionId: string; readonly seq: number }) =>
  `${row.sessionId}#${row.seq}`;

const parseToolCallId = (id: string): { readonly sessionId: string; readonly seq: number } => {
  const index = id.lastIndexOf("#");
  const seq = Number.parseInt(id.slice(index + 1), 10);
  if (index <= 0 || !Number.isInteger(seq)) {
    throw new CommandInputError({
      field: "toolCallId",
      message: "toolCallId must be in the form <sessionId>#<seq>",
    });
  }
  return { sessionId: id.slice(0, index), seq };
};

const normalizeToolCall = <T extends { readonly sessionId: string; readonly seq: number }>(row: T) => ({
  toolCallId: toolCallId(row),
  ...row,
});

const listProjects = async (limit = DEFAULT_LIMIT) => {
  const client = createConvexClient();
  const projects = await withRetry(() => client.query(api.quasar.listProjects, { limit }));
  return { projects };
};

const listSessionsForProject = async (options: {
  readonly projectKey: string;
  readonly limit: number;
  readonly provider?: string;
}) => {
  const client = createConvexClient();
  const sessions = [] as unknown[];
  let cursor: string | null = null;
  do {
    const page = await withRetry(() =>
      client.query(api.quasar.listSessions, {
        projectKey: options.projectKey,
        paginationOpts: { numItems: PAGE_SIZE, cursor },
      }),
    );
    for (const session of page.page) {
      if (options.provider !== undefined && session.provider !== options.provider) continue;
      sessions.push(session);
      if (sessions.length >= options.limit) break;
    }
    cursor = page.isDone || sessions.length >= options.limit ? null : page.continueCursor;
  } while (cursor !== null);
  return sessions;
};

const listSessions = async (options: {
  readonly projectKey?: string;
  readonly provider?: string;
  readonly limit: number;
}) => {
  if (options.projectKey !== undefined) {
    return {
      sessions: await listSessionsForProject({
        projectKey: options.projectKey,
        provider: options.provider,
        limit: options.limit,
      }),
    };
  }

  const { projects } = await listProjects(MAX_LIMIT);
  const sessions = [] as unknown[];
  for (const project of projects) {
    const projectSessions = await listSessionsForProject({
      projectKey: project.projectKey,
      provider: options.provider,
      limit: options.limit - sessions.length,
    });
    sessions.push(...projectSessions);
    if (sessions.length >= options.limit) break;
  }
  return { sessions };
};

const readSession = async (sessionId: string, limit: number) => {
  const client = createConvexClient();
  const messages = [] as unknown[];
  let cursor: string | null = null;
  do {
    const page = await withRetry(() =>
      client.query(api.quasar.readSession, {
        sessionId,
        paginationOpts: { numItems: Math.min(PAGE_SIZE, limit - messages.length), cursor },
      }),
    );
    messages.push(...page.page);
    cursor = page.isDone || messages.length >= limit ? null : page.continueCursor;
  } while (cursor !== null);
  return { sessionId, messages };
};

const listToolCallsForSession = async (sessionId: string, limit: number) => {
  const client = createConvexClient();
  const toolCalls = [] as unknown[];
  let cursor: string | null = null;
  do {
    const page = await withRetry(() =>
      client.query(api.quasar.sessionToolCalls, {
        sessionId,
        paginationOpts: { numItems: Math.min(PAGE_SIZE, limit - toolCalls.length), cursor },
      }),
    );
    toolCalls.push(...page.page.map(normalizeToolCall));
    cursor = page.isDone || toolCalls.length >= limit ? null : page.continueCursor;
  } while (cursor !== null);
  return toolCalls;
};

const listToolCallsByProjectAndName = async (options: {
  readonly projectKey: string;
  readonly toolName: string;
  readonly limit: number;
}) => {
  const client = createConvexClient();
  const toolCalls = [] as unknown[];
  let cursor: string | null = null;
  do {
    const page = await withRetry(() =>
      client.query(api.quasar.toolCallsByName, {
        projectKey: options.projectKey,
        toolName: options.toolName,
        paginationOpts: { numItems: Math.min(PAGE_SIZE, options.limit - toolCalls.length), cursor },
      }),
    );
    toolCalls.push(...page.page.map(normalizeToolCall));
    cursor = page.isDone || toolCalls.length >= options.limit ? null : page.continueCursor;
  } while (cursor !== null);
  return toolCalls;
};

const listToolCalls = async (options: {
  readonly sessionId?: string;
  readonly projectKey?: string;
  readonly toolName?: string;
  readonly limit: number;
}) => {
  if (options.sessionId !== undefined) {
    return { toolCalls: await listToolCallsForSession(options.sessionId, options.limit) };
  }
  if (options.projectKey !== undefined && options.toolName !== undefined) {
    return { toolCalls: await listToolCallsByProjectAndName({
      projectKey: options.projectKey,
      toolName: options.toolName,
      limit: options.limit,
    }) };
  }
  throw new CommandInputError({
    field: "filters",
    message: "tool-calls list requires --session or both --project and --tool-name",
  });
};

const readToolCall = async (id: string) => {
  const parsed = parseToolCallId(id);
  const toolCalls = await listToolCallsForSession(parsed.sessionId, MAX_LIMIT);
  const match = toolCalls.find((row) =>
    typeof row === "object" && row !== null && (row as { seq?: unknown }).seq === parsed.seq,
  );
  return { toolCall: match ?? null };
};

const projectsListCommand = Command.make("list", { limit: limitOption }, ({ limit }) =>
  executeJsonCommand(
    "projects list",
    Effect.tryPromise({
      try: () => listProjects(checkedLimit(limit)),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
  ),
);

export const projectsCommand = Command.make("projects").pipe(
  Command.withSubcommands([projectsListCommand]),
);

const sessionsListCommand = Command.make(
  "list",
  { project: projectOption, provider: providerOption, limit: limitOption },
  ({ project, provider, limit }) =>
    executeJsonCommand(
      "sessions list",
      Effect.tryPromise({
        try: () => listSessions({
          projectKey: Option.getOrUndefined(project),
          provider: Option.getOrUndefined(provider),
          limit: checkedLimit(limit),
        }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);

const sessionsReadCommand = Command.make(
  "read",
  { sessionId: sessionIdArg, limit: limitOption },
  ({ sessionId, limit }) =>
    executeJsonCommand(
      "sessions read",
      Effect.tryPromise({
        try: () => readSession(sessionId, checkedLimit(limit)),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);

export const sessionsCommand = Command.make("sessions").pipe(
  Command.withSubcommands([sessionsListCommand, sessionsReadCommand]),
);

const toolCallsListCommand = Command.make(
  "list",
  {
    session: Options.text("session").pipe(Options.optional),
    project: projectOption,
    toolName: toolNameOption,
    limit: limitOption,
  },
  ({ session, project, toolName, limit }) =>
    executeJsonCommand(
      "tool-calls list",
      Effect.tryPromise({
        try: () => listToolCalls({
          sessionId: Option.getOrUndefined(session),
          projectKey: Option.getOrUndefined(project),
          toolName: Option.getOrUndefined(toolName),
          limit: checkedLimit(limit),
        }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);

const toolCallsReadCommand = Command.make(
  "read",
  { toolCallId: toolCallIdArg },
  ({ toolCallId }) =>
    executeJsonCommand(
      "tool-calls read",
      Effect.tryPromise({
        try: () => readToolCall(toolCallId),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);

export const toolCallsCommand = Command.make("tool-calls").pipe(
  Command.withSubcommands([toolCallsListCommand, toolCallsReadCommand]),
);
