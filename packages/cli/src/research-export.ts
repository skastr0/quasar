import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  RESEARCH_EXPORT_PROTOCOL_VERSION,
  decodeResearchExportFiltersSync,
  decodeResearchExportFrameSync,
  type ResearchExportFilters,
  type ResearchExportManifestFrame,
  type ResearchExportReceiptFrame,
  type ResearchExportScanKey,
  type TrajectoryProjectionOptions,
} from "@skastr0/quasar-protocol";

import {
  QueryProtocolError,
  QueryTransportError,
  fetchWithRetry,
  type FetchRequestOptions,
} from "./query-client";
import type { CommonQueryFilters } from "./query-spec";

interface ResearchExportCursorPayload {
  readonly version: 1;
  readonly kind: "research-export";
  readonly fingerprint: string;
  readonly snapshot: string;
  readonly after: ResearchExportScanKey;
}

export interface ResearchExportOptions extends FetchRequestOptions {
  readonly serverUrl: string;
  readonly outputPath: string;
  readonly filters: CommonQueryFilters;
  readonly limit: number;
  readonly cursor?: string;
  readonly trajectoryProjection: TrajectoryProjectionOptions;
}

export interface ResearchExportResult {
  readonly protocolVersion: typeof RESEARCH_EXPORT_PROTOCOL_VERSION;
  readonly outputPath: string;
  readonly snapshot: string;
  readonly complete: boolean;
  readonly counts: ResearchExportReceiptFrame["counts"];
  readonly content: ResearchExportReceiptFrame["content"];
  readonly artifact: {
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly nextCursor?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalValue(value));

const compactFilters = (
  filters: CommonQueryFilters,
): ResearchExportFilters =>
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

const fingerprint = (
  options: Pick<
    ResearchExportOptions,
    "filters" | "limit" | "trajectoryProjection"
  >,
): string =>
  createHash("sha256")
    .update(canonicalJson({
      filters: compactFilters(options.filters),
      limit: options.limit,
      trajectoryProjection: options.trajectoryProjection,
    }))
    .digest("base64url");

const cursorPayload = (
  cursor: string | undefined,
  options: Pick<
    ResearchExportOptions,
    "filters" | "limit" | "trajectoryProjection"
  >,
): ResearchExportCursorPayload | undefined => {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
  } catch (error) {
    throw new QueryProtocolError("research export cursor is malformed", {
      cursor,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const after = isRecord(parsed) && isRecord(parsed.after)
    ? parsed.after
    : undefined;
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || parsed.kind !== "research-export"
    || parsed.fingerprint !== fingerprint(options)
    || typeof parsed.snapshot !== "string"
    || parsed.snapshot.trim() === ""
    || after === undefined
    || typeof after.sessionId !== "string"
    || after.sessionId.trim() === ""
    || !Number.isSafeInteger(after.sequence)
    || (after.sequence as number) < 0
  ) {
    throw new QueryProtocolError(
      "research export cursor does not match the export shape",
      { cursor },
    );
  }
  return {
    version: 1,
    kind: "research-export",
    fingerprint: parsed.fingerprint,
    snapshot: parsed.snapshot,
    after: {
      sessionId: after.sessionId,
      sequence: after.sequence as number,
    },
  };
};

const encodeCursor = (
  options: Pick<
    ResearchExportOptions,
    "filters" | "limit" | "trajectoryProjection"
  >,
  snapshot: string,
  after: ResearchExportScanKey,
): string =>
  Buffer.from(JSON.stringify({
    version: 1,
    kind: "research-export",
    fingerprint: fingerprint(options),
    snapshot,
    after,
  } satisfies ResearchExportCursorPayload), "utf8").toString("base64url");

const resourceUrl = (
  options: ResearchExportOptions,
  cursor: ResearchExportCursorPayload | undefined,
): URL => {
  const url = new URL(
    "research-export",
    options.serverUrl.endsWith("/")
      ? options.serverUrl
      : `${options.serverUrl}/`,
  );
  const filters = compactFilters(options.filters);
  const params: Record<string, string | undefined> = {
    projectKey: filters.projectKey,
    provider: filters.providers?.join(","),
    sessionId: filters.sessionId,
    role: filters.role,
    agentName: filters.agentName,
    agentRole: filters.agentRole,
    model: filters.model,
    modelProvider: filters.modelProvider,
    messageAfter: filters.messageAfter,
    messageBefore: filters.messageBefore,
    sessionStartedAfter: filters.sessionStartedAfter,
    sessionStartedBefore: filters.sessionStartedBefore,
    rootsOnly: filters.rootsOnly === undefined
      ? undefined
      : String(filters.rootsOnly),
    lineageRootSessionId: filters.lineageRootSessionId,
    limit: String(options.limit),
    includeReasoning: String(
      options.trajectoryProjection.includeReasoning,
    ),
    includeToolResults: String(
      options.trajectoryProjection.includeToolResults,
    ),
    toolResultMaxBytes:
      options.trajectoryProjection.toolResultMaxBytes === undefined
        ? undefined
        : String(options.trajectoryProjection.toolResultMaxBytes),
    afterSessionId: cursor?.after.sessionId,
    afterSequence: cursor === undefined
      ? undefined
      : String(cursor.after.sequence),
    snapshot: cursor?.snapshot,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url;
};

const compareKeys = (
  left: ResearchExportScanKey,
  right: ResearchExportScanKey,
): number =>
  Buffer.compare(
    Buffer.from(left.sessionId, "utf8"),
    Buffer.from(right.sessionId, "utf8"),
  )
  || left.sequence - right.sequence;

const responseErrorBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const errorMessage = (body: unknown, fallback: string): string => {
  if (!isRecord(body) || !isRecord(body.error)) return fallback;
  return typeof body.error.message === "string"
    ? body.error.message
    : fallback;
};

const outputExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      isRecord(error)
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

export const runResearchExport = async (
  options: ResearchExportOptions,
): Promise<ResearchExportResult> => {
  const outputPath = resolve(options.outputPath);
  if (await outputExists(outputPath)) {
    throw new QueryProtocolError(
      "research export output already exists",
      { outputPath },
    );
  }
  const cursor = cursorPayload(options.cursor, options);
  const response = await fetchWithRetry(
    resourceUrl(options, cursor),
    options,
  );
  if (!response.ok) {
    const body = await responseErrorBody(response);
    throw new QueryTransportError(
      response.status,
      errorMessage(
        body,
        `research export request failed with HTTP ${response.status}`,
      ),
      body,
    );
  }
  if (response.body === null) {
    throw new QueryProtocolError(
      "research export response has no body",
      null,
    );
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  const contentHash = createHash("sha256");
  const artifactHash = createHash("sha256");
  let contentBytes = 0;
  let artifactBytes = 0;
  let manifest: ResearchExportManifestFrame | undefined;
  let receipt: ResearchExportReceiptFrame | undefined;
  let messageCount = 0;
  let trajectoryCount = 0;
  let lastMessageKey: ResearchExportScanKey | undefined;
  const representedSessions = new Set<string>();
  const trajectorySessions = new Set<string>();

  const writeLine = async (line: string) => {
    const bytes = Buffer.byteLength(line);
    artifactHash.update(line, "utf8");
    artifactBytes += bytes;
    await handle.write(line);
  };

  const consumeLine = async (raw: string) => {
    if (raw === "") {
      throw new QueryProtocolError(
        "research export contains an empty NDJSON frame",
        null,
      );
    }
    const line = `${raw}\n`;
    const frame = decodeResearchExportFrameSync(
      JSON.parse(raw) as unknown,
    );
    if (receipt !== undefined) {
      throw new QueryProtocolError(
        "research export contains frames after its receipt",
        frame,
      );
    }
    if (frame.kind === "error") {
      throw new QueryProtocolError(
        frame.error.message,
        frame.error,
      );
    }
    if (frame.kind === "receipt") {
      if (manifest === undefined) {
        throw new QueryProtocolError(
          "research export receipt arrived before its manifest",
          frame,
        );
      }
      const digest = `sha256:${contentHash.digest("hex")}`;
      if (
        frame.snapshot !== manifest.snapshot
        || frame.content.bytes !== contentBytes
        || frame.content.sha256 !== digest
        || frame.counts.messages !== messageCount
        || frame.counts.trajectories !== trajectoryCount
      ) {
        throw new QueryProtocolError(
          "research export receipt does not match streamed content",
          {
            received: frame,
            observed: {
              snapshot: manifest.snapshot,
              content: { bytes: contentBytes, sha256: digest },
              counts: {
                messages: messageCount,
                trajectories: trajectoryCount,
              },
            },
          },
        );
      }
      if (
        frame.next !== null
        && (
          lastMessageKey === undefined
          || compareKeys(frame.next, lastMessageKey) !== 0
        )
      ) {
        throw new QueryProtocolError(
          "research export continuation does not match its last message",
          { next: frame.next, lastMessageKey },
        );
      }
      receipt = frame;
      await writeLine(line);
      return;
    }

    if (frame.kind === "manifest") {
      if (manifest !== undefined || messageCount > 0 || trajectoryCount > 0) {
        throw new QueryProtocolError(
          "research export contains more than one manifest",
          frame,
        );
      }
      const expectedFilters = compactFilters(options.filters);
      if (
        frame.page.limit !== options.limit
        || canonicalJson(frame.filters) !== canonicalJson(expectedFilters)
        || canonicalJson(frame.trajectoryProjection)
          !== canonicalJson(options.trajectoryProjection)
        || canonicalJson(frame.page.after ?? null)
          !== canonicalJson(cursor?.after ?? null)
        || (
          cursor !== undefined
          && frame.snapshot !== cursor.snapshot
        )
      ) {
        throw new QueryProtocolError(
          "research export manifest does not match the request",
          {
            received: frame,
            expected: {
              filters: expectedFilters,
              page: {
                limit: options.limit,
                after: cursor?.after ?? null,
              },
              trajectoryProjection: options.trajectoryProjection,
              snapshot: cursor?.snapshot,
            },
          },
        );
      }
      manifest = frame;
    } else if (manifest === undefined) {
      throw new QueryProtocolError(
        "research export data arrived before its manifest",
        frame,
      );
    } else if (frame.kind === "message") {
      if (trajectoryCount > 0) {
        throw new QueryProtocolError(
          "research export message arrived after trajectory frames",
          frame.message,
        );
      }
      const key = {
        sessionId: frame.message.sessionId,
        sequence: frame.message.sequence,
      };
      if (
        (
          lastMessageKey !== undefined
          && compareKeys(lastMessageKey, key) >= 0
        )
        || (
          lastMessageKey === undefined
          && cursor !== undefined
          && compareKeys(cursor.after, key) >= 0
        )
      ) {
        throw new QueryProtocolError(
          "research export messages are not in advancing key order",
          { previous: lastMessageKey ?? cursor?.after, current: key },
        );
      }
      lastMessageKey = key;
      representedSessions.add(frame.message.sessionId);
      messageCount += 1;
    } else {
      if (
        frame.sessionId !== frame.trajectory.sessionId
        || !representedSessions.has(frame.sessionId)
        || frame.sessionId === manifest.page.after?.sessionId
        || trajectorySessions.has(frame.sessionId)
      ) {
        throw new QueryProtocolError(
          "research export trajectory does not match one represented session",
          {
            sessionId: frame.sessionId,
            trajectorySessionId: frame.trajectory.sessionId,
          },
        );
      }
      trajectorySessions.add(frame.sessionId);
      trajectoryCount += 1;
    }

    contentHash.update(line, "utf8");
    contentBytes += Buffer.byteLength(line);
    await writeLine(line);
  };

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        await consumeLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered !== "") {
      throw new QueryProtocolError(
        "research export ended with an unterminated NDJSON frame",
        buffered,
      );
    }
    if (manifest === undefined || receipt === undefined) {
      throw new QueryProtocolError(
        "research export ended without a manifest and checksum receipt",
        {
          manifest: manifest !== undefined,
          receipt: receipt !== undefined,
        },
      );
    }
    const continuedSessionId = manifest.page.after?.sessionId;
    const expectedTrajectorySessions = new Set(
      [...representedSessions].filter((sessionId) =>
        sessionId !== continuedSessionId
      ),
    );
    if (
      trajectorySessions.size !== expectedTrajectorySessions.size
      || [...expectedTrajectorySessions].some(
        (sessionId) => !trajectorySessions.has(sessionId),
      )
    ) {
      throw new QueryProtocolError(
        "research export omitted trajectories for represented sessions",
        {
          expectedTrajectorySessions: [...expectedTrajectorySessions],
          trajectorySessions: [...trajectorySessions],
        },
      );
    }
    await handle.sync();
    await handle.close();
    await link(temporaryPath, outputPath);
    await unlink(temporaryPath);
    return {
      protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
      outputPath,
      snapshot: receipt.snapshot,
      complete: receipt.next === null,
      counts: receipt.counts,
      content: receipt.content,
      artifact: {
        bytes: artifactBytes,
        sha256: `sha256:${artifactHash.digest("hex")}`,
      },
      ...(receipt.next === null
        ? {}
        : {
            nextCursor: encodeCursor(
              options,
              receipt.snapshot,
              receipt.next,
            ),
          }),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};
