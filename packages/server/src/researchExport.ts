import { createHash } from "node:crypto";

import {
  RESEARCH_EXPORT_PROTOCOL_VERSION,
  decodeResearchExportFiltersSync,
  decodeResearchExportFrameSync,
  projectQuasarTrajectory,
  type ResearchExportErrorFrame,
  type ResearchExportFilters,
  type ResearchExportFrame,
  type ResearchExportManifestFrame,
  type ResearchExportReceiptFrame,
  type TrajectoryProjectionInput,
} from "@skastr0/quasar-protocol";
import { Effect, Schema, Stream } from "effect";

import {
  executeMessageQuery,
  QuerySnapshotExpiredError,
  type MessagePageRequest,
  type ResourceFilters,
} from "./query";
import {
  LocalStore,
  StoredSessionContractError,
  type LocalStoreService,
} from "./store";

export interface ResearchExportRequest {
  readonly filters: ResourceFilters;
  readonly page: MessagePageRequest;
  readonly trajectoryProjection: Required<
    Pick<
      TrajectoryProjectionInput,
      "includeReasoning" | "includeToolResults"
    >
  > & Pick<TrajectoryProjectionInput, "toolResultMaxBytes">;
}

export interface ResearchExportStream {
  readonly snapshot: string;
  readonly body: Stream.Stream<Uint8Array>;
}

class ResearchExportSessionMissingError extends Schema.TaggedError<ResearchExportSessionMissingError>()(
  "ResearchExportSessionMissingError",
  {
    message: Schema.String,
    sessionId: Schema.String,
  },
) {}

class ResearchExportProjectionError extends Schema.TaggedError<ResearchExportProjectionError>()(
  "ResearchExportProjectionError",
  {
    message: Schema.String,
    sessionId: Schema.String,
  },
) {}

const serializeFrame = (frame: ResearchExportFrame): string =>
  `${JSON.stringify(decodeResearchExportFrameSync(frame))}\n`;

const exportedFilters = (filters: ResourceFilters): ResearchExportFilters =>
  decodeResearchExportFiltersSync({
    ...(filters.projectKey === undefined
      ? {}
      : { projectKey: filters.projectKey }),
    ...(filters.providers === undefined
      ? {}
      : { providers: [...filters.providers] }),
    ...(filters.sessionId === undefined
      ? {}
      : { sessionId: filters.sessionId }),
    ...(filters.role === undefined ? {} : { role: filters.role }),
    ...(filters.agentName === undefined
      ? {}
      : { agentName: filters.agentName }),
    ...(filters.agentRole === undefined
      ? {}
      : { agentRole: filters.agentRole }),
    ...(filters.model === undefined ? {} : { model: filters.model }),
    ...(filters.modelProvider === undefined
      ? {}
      : { modelProvider: filters.modelProvider }),
    ...(filters.messageAfter === undefined
      ? {}
      : { messageAfter: filters.messageAfter }),
    ...(filters.messageBefore === undefined
      ? {}
      : { messageBefore: filters.messageBefore }),
    ...(filters.sessionStartedAfter === undefined
      ? {}
      : { sessionStartedAfter: filters.sessionStartedAfter }),
    ...(filters.sessionStartedBefore === undefined
      ? {}
      : { sessionStartedBefore: filters.sessionStartedBefore }),
    ...(filters.rootsOnly === undefined
      ? {}
      : { rootsOnly: filters.rootsOnly }),
    ...(filters.lineageRootSessionId === undefined
      ? {}
      : { lineageRootSessionId: filters.lineageRootSessionId }),
  });

const assertSnapshot = (
  store: LocalStoreService,
  expected: string,
) =>
  store.querySnapshot.pipe(
    Effect.flatMap((actual) =>
      actual.writing || actual.id !== expected
        ? new QuerySnapshotExpiredError({
            message:
              "the session corpus changed while the research export was streamed",
            expected,
            actual: actual.id,
          })
        : Effect.void
    ),
  );

const trajectoryFrame = (
  store: LocalStoreService,
  snapshot: string,
  sessionId: string,
  projection: ResearchExportRequest["trajectoryProjection"],
) =>
  Effect.gen(function* () {
    yield* assertSnapshot(store, snapshot);
    const source = yield* store.readMappedSession(sessionId);
    if (source === undefined) {
      return yield* new ResearchExportSessionMissingError({
        message: "session disappeared while its trajectory was exported",
        sessionId,
      });
    }
    const trajectory = yield* Effect.try({
      try: () => projectQuasarTrajectory(source, projection),
      catch: () =>
        new ResearchExportProjectionError({
          message: "stored session trajectory projection failed",
          sessionId,
        }),
    });
    yield* assertSnapshot(store, snapshot);
    return {
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "trajectory",
      sessionId,
      trajectory,
    } as const;
  });

const errorFrame = (error: unknown): ResearchExportErrorFrame => {
  if (error instanceof QuerySnapshotExpiredError) {
    return {
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "error",
      error: {
        type: error._tag,
        message: error.message,
      },
    };
  }
  if (error instanceof StoredSessionContractError) {
    return {
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "error",
      error: {
        type: "TrajectorySourceInvalid",
        message: error.message,
        sessionId: error.sessionId,
      },
    };
  }
  if (
    error instanceof ResearchExportSessionMissingError
    || error instanceof ResearchExportProjectionError
  ) {
    return {
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "error",
      error: {
        type: error._tag,
        message: error.message,
        sessionId: error.sessionId,
      },
    };
  }
  return {
    protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
    kind: "error",
    error: {
      type: "ResearchExportStreamError",
      message: "research export stream failed",
    },
  };
};

export const makeResearchExportStream = (
  request: ResearchExportRequest,
): Effect.Effect<
  ResearchExportStream,
  unknown,
  LocalStore
> =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const result = yield* executeMessageQuery({
      kind: "messages",
      filters: request.filters,
      page: request.page,
    });
    const snapshot = result.page.snapshot;
    const manifest: ResearchExportManifestFrame = {
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "manifest",
      snapshot,
      filters: exportedFilters(request.filters),
      page: {
        limit: request.page.limit,
        after: request.page.after ?? null,
      },
      trajectoryScope: "first-matching-message-in-scan",
      trajectoryProjection: request.trajectoryProjection,
    };
    const messageFrames = result.rows.map((message) => ({
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      kind: "message",
      message,
    } as const));
    const sessionIds = [
      ...new Set(result.rows.map((message) => message.sessionId)),
    ].filter((sessionId) =>
      sessionId !== request.page.after?.sessionId
    );

    const hash = createHash("sha256");
    let contentBytes = 0;
    const contentLine = (frame: ResearchExportFrame): string => {
      const line = serializeFrame(frame);
      hash.update(line, "utf8");
      contentBytes += Buffer.byteLength(line);
      return line;
    };

    const initial = Stream.fromIterable([
      manifest,
      ...messageFrames,
    ]).pipe(Stream.map(contentLine));
    const trajectories = Stream.fromIterable(sessionIds).pipe(
      Stream.mapEffect((sessionId) =>
        trajectoryFrame(
          store,
          snapshot,
          sessionId,
          request.trajectoryProjection,
        )
      ),
      Stream.map(contentLine),
    );
    const receipt = Stream.fromEffect(
      assertSnapshot(store, snapshot).pipe(
        Effect.map(() => {
          const frame: ResearchExportReceiptFrame = {
            protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
            kind: "receipt",
            snapshot,
            counts: {
              messages: result.rows.length,
              trajectories: sessionIds.length,
            },
            content: {
              bytes: contentBytes,
              sha256: `sha256:${hash.digest("hex")}`,
            },
            next: result.page.next,
          };
          return serializeFrame(frame);
        }),
      ),
    );

    const body = initial.pipe(
      Stream.concat(trajectories),
      Stream.concat(receipt),
      Stream.catchAll((error) =>
        Stream.make(serializeFrame(errorFrame(error)))
      ),
      Stream.encodeText,
    );
    return { snapshot, body };
  });
