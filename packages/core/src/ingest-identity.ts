import { stableJsonHash } from "./hash";
import type { IngestManifest } from "./schemas";
import { SESSION_INTELLIGENCE_CONTRACT_VERSION } from "./session-intelligence";

export const STREAM_INGEST_UPLOAD_IDENTITY_VERSION = "quasar.stream-ingest/v4";

type IngestProviderSummary = NonNullable<IngestManifest["providerSummaries"]>[number];

export const providerSummariesForManifest = (manifest: IngestManifest) =>
  manifest.providerSummaries ?? providerSummariesFromManifestSessions(manifest.sessions);

export const providerSummariesFromManifestSessions = (
  sessions: readonly IngestManifest["sessions"][number][],
): IngestProviderSummary[] => {
  const summaries = new Map<string, IngestProviderSummary>();
  for (const session of sessions) {
    const current = summaries.get(session.provider) ?? {
      provider: session.provider,
      sessionCount: 0,
      eventCount: 0,
      toolCallCount: 0,
      contentBlockCount: 0,
      sessionEdgeCount: 0,
      usageRecordCount: 0,
      artifactCount: 0,
    };
    summaries.set(session.provider, {
      provider: session.provider,
      sessionCount: current.sessionCount + 1,
      eventCount: current.eventCount + session.eventCount,
      toolCallCount: current.toolCallCount + session.toolCallCount,
      contentBlockCount: current.contentBlockCount + session.contentBlockCount,
      sessionEdgeCount: current.sessionEdgeCount + session.sessionEdgeCount,
      usageRecordCount: current.usageRecordCount + session.usageRecordCount,
      artifactCount: current.artifactCount + session.artifactCount,
    });
  }
  return [...summaries.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
};

export const streamedIngestJobIdempotencyKey = (
  manifest: IngestManifest,
  chunkPayloadFingerprint: string,
) =>
  `import-job:${stableJsonHash([
    STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
    SESSION_INTELLIGENCE_CONTRACT_VERSION,
    manifestIdentityFromManifest(manifest),
    chunkPayloadFingerprint,
  ])}`;

export const manifestIdentityFromManifest = (manifest: IngestManifest) => ({
  ...manifest,
  generatedAt: undefined,
  sourceRoots: manifest.sourceRoots.map(sourceRootIdentity),
  sessions: undefined,
  providerSummaries: providerSummariesForManifest(manifest),
});

export const sourceRootIdentity = (root: IngestManifest["sourceRoots"][number]) => ({
  ...root,
  discoveredAt: undefined,
});
