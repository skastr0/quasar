import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

import {
  allAdapters,
  loadMachineIdentity,
  readAdapters,
  stableAdapters,
  type Provider,
  type SessionAdapter,
} from "@skastr0/quasar-core";

import { loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { IngestOptions } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);
const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

const selectAdapters = (
  providers: readonly Provider[] | undefined,
  includeExperimental: boolean,
): readonly SessionAdapter[] => {
  const candidates: readonly SessionAdapter[] = includeExperimental ? allAdapters : stableAdapters;
  if (providers === undefined || providers.length === 0) return candidates;
  const selected = new Set<Provider>(providers);
  return candidates.filter((adapter) => selected.has(adapter.provider));
};

const summarizeSessions = (sessions: Awaited<ReturnType<typeof readAdapters>>["sessions"]) => ({
  sessionCount: sessions.length,
  eventCount: sessions.reduce((count, session) => count + session.events.length, 0),
  toolCallCount: sessions.reduce((count, session) => count + session.toolCalls.length, 0),
  contentBlockCount: sessions.reduce(
    (count, session) =>
      count + session.events.reduce((total, event) => total + event.contentBlocks.length, 0),
    0,
  ),
  sessionEdgeCount: sessions.reduce((count, session) => count + session.sessionEdges.length, 0),
  usageRecordCount: sessions.reduce((count, session) => count + session.usageRecords.length, 0),
  artifactCount: sessions.reduce((count, session) => count + session.artifacts.length, 0),
});

export const sourcesCommand = Command.make("sources").pipe(
  Command.withSubcommands([
    Command.make("discover", { input: inputArg }, ({ input }) =>
      executeJsonCommand(
        "sources discover",
        Effect.gen(function* () {
          const inputText = toUndefined(input);
          const options = yield* loadOptionalJsonInput(
            IngestOptions,
            inputText,
            { includeExperimental: true },
          );
          const effectiveLimit = options.limit ?? 1;
          const summary = yield* Effect.tryPromise({
            try: async () => {
              const adapters = selectAdapters(
                options.providers,
                options.includeExperimental ?? true,
              );
              const now = new Date().toISOString();
              const result = await readAdapters(adapters, {
                machine: loadMachineIdentity(),
                now,
                limit: effectiveLimit,
                skip: options.skip,
                roots: options.roots,
                logicalRoots: options.logicalRoots,
              });
              return {
                generatedAt: now,
                providers: adapters.map((adapter) => ({
                  id: adapter.id,
                  provider: adapter.provider,
                  displayName: adapter.displayName,
                  stable: adapter.stable,
                })),
                sourceRootCount: result.sourceRoots.length,
                diagnostics: {
                  count: result.diagnostics.length,
                  rows: result.diagnostics,
                },
                ...summarizeSessions(result.sessions),
              };
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
          return {
            ...summary,
            selection: {
              limit: effectiveLimit,
              skip: options.skip ?? 0,
              defaultLimitApplied: options.limit === undefined,
            },
          };
        }),
      ),
    ),
  ]),
);
