import {
  type IngestBatch as CoreIngestBatch,
} from "@skastr0/quasar-core/schemas";
import {
  jsonByteLength,
  projectSessionIntelligenceGraphId,
  toConvexSafeSessionIntelligenceBatch,
} from "@skastr0/quasar-core/session-intelligence";
import {
  decodeBoundarySync,
  IngestBatchBoundary,
  type IngestBatchBoundary as IngestBatchBoundaryValue,
  type IngestSessionBoundary,
} from "./quasarDomainSchemas";

const MAX_CLEANUP_ID_BYTES = 512;
const MAX_CLEANUP_ID_ARRAY_BYTES = 512 * 1024;

const cleanupIdFields = [
  "expectedEventIds",
  "expectedToolCallIds",
  "expectedContentBlockIds",
  "expectedSessionEdgeIds",
  "expectedUsageRecordIds",
  "expectedArtifactIds",
] as const;

type CleanupIdField = (typeof cleanupIdFields)[number];

export const sanitizeIngestBoundaryBatch = (
  batch: IngestBatchBoundaryValue,
  label: string,
): IngestBatchBoundaryValue => {
  const restored = restoreIngestControlMetadata(
    batch,
    toConvexSafeSessionIntelligenceBatch(toCoreIngestBatch(batch)),
  );
  assertIngestControlMetadataBudget(restored, label);
  return decodeBoundarySync(IngestBatchBoundary, restored, `sanitized ${label}`);
};

const toCoreIngestBatch = (batch: IngestBatchBoundaryValue): CoreIngestBatch => ({
  ...batch,
  sessions: batch.sessions.map((session) => ({
    ...session,
    events: session.events.map((event) => ({
      ...event,
      sessionId: session.id,
      machineId: session.machineId,
      provider: session.provider,
      agentName: session.agentName,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
    })),
    toolCalls: session.toolCalls.map((toolCall) => ({
      ...toolCall,
      sessionId: session.id,
      eventId: toolCall.eventId ?? `declared:${toolCall.id}`,
      machineId: session.machineId,
      provider: session.provider,
      agentName: session.agentName,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
    })),
    sessionEdges: session.sessionEdges.map((edge) => ({
      ...edge,
      sessionId: session.id,
      machineId: session.machineId,
      provider: session.provider,
      agentName: session.agentName,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
    })),
    usageRecords: session.usageRecords.map((usageRecord) => ({
      ...usageRecord,
      sessionId: session.id,
      machineId: session.machineId,
      provider: session.provider,
      agentName: session.agentName,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
    })),
    artifacts: session.artifacts.map((artifact) => ({
      ...artifact,
      sessionId: session.id,
      machineId: session.machineId,
      provider: session.provider,
      agentName: session.agentName,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
    })),
  })),
});

const restoreIngestControlMetadata = (
  original: IngestBatchBoundaryValue,
  sanitized: CoreIngestBatch,
): IngestBatchBoundaryValue => ({
  ...sanitized,
  sessions: sanitized.sessions.map((session, index) => {
    const control = original.sessions[index];
    return {
      ...session,
      ...(control?.expectedEventIds !== undefined
        ? { expectedEventIds: projectExpectedIds(control.expectedEventIds, "event") }
        : {}),
      ...(control?.expectedToolCallIds !== undefined
        ? { expectedToolCallIds: projectExpectedIds(control.expectedToolCallIds, "tool_call") }
        : {}),
      ...(control?.expectedContentBlockIds !== undefined
        ? { expectedContentBlockIds: projectExpectedIds(control.expectedContentBlockIds, "content_block") }
        : {}),
      ...(control?.expectedSessionEdgeIds !== undefined
        ? { expectedSessionEdgeIds: projectExpectedIds(control.expectedSessionEdgeIds, "session_edge") }
        : {}),
      ...(control?.expectedUsageRecordIds !== undefined
        ? { expectedUsageRecordIds: projectExpectedIds(control.expectedUsageRecordIds, "usage_record") }
        : {}),
      ...(control?.expectedArtifactIds !== undefined
        ? { expectedArtifactIds: projectExpectedIds(control.expectedArtifactIds, "artifact") }
        : {}),
      ...(control?.partialSession !== undefined ? { partialSession: control.partialSession } : {}),
      ...(control?.deferCleanup !== undefined ? { deferCleanup: control.deferCleanup } : {}),
    };
  }),
});

const projectExpectedIds = (
  ids: readonly string[],
  kind:
    | "event"
    | "tool_call"
    | "content_block"
    | "session_edge"
    | "usage_record"
    | "artifact",
) => ids.map((id) => projectSessionIntelligenceGraphId(kind, id));

const assertIngestControlMetadataBudget = (
  batch: IngestBatchBoundaryValue,
  label: string,
) => {
  batch.sessions.forEach((session, index) => {
    for (const field of cleanupIdFields) {
      assertCleanupIdArrayBudget(session, field, `${label}.sessions[${index}].${field}`);
    }
  });
};

const assertCleanupIdArrayBudget = (
  session: IngestSessionBoundary,
  field: CleanupIdField,
  path: string,
) => {
  const ids = session[field];
  if (ids === undefined) return;
  const bytes = jsonByteLength(ids);
  if (bytes > MAX_CLEANUP_ID_ARRAY_BYTES) {
    throw new Error(
      `${path} is ${bytes} bytes; maximum is ${MAX_CLEANUP_ID_ARRAY_BYTES} bytes. Use deferCleanup for oversized reconciliation metadata.`,
    );
  }
  ids.forEach((id, index) => {
    const idBytes = jsonByteLength(id);
    if (idBytes > MAX_CLEANUP_ID_BYTES) {
      throw new Error(
        `${path}[${index}] is ${idBytes} bytes; maximum is ${MAX_CLEANUP_ID_BYTES} bytes.`,
      );
    }
  });
};
