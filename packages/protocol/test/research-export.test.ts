import { describe, expect, test } from "bun:test";

import {
  RESEARCH_EXPORT_PROTOCOL_VERSION,
  decodeResearchExportFrameSync,
  projectQuasarTrajectory,
  protocolContracts,
} from "../src/index";

const mapped = protocolContracts.mappedSession.examples[0].input;
const mappedSession = mapped as any;
const trajectory = projectQuasarTrajectory(mapped);

const frames = [
  {
    protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
    kind: "manifest",
    snapshot: "corpus-example:7",
    filters: { projectKey: mapped.project.projectKey },
    page: { limit: 1, after: null },
    trajectoryScope: "first-matching-message-in-scan",
    trajectoryProjection: {
      includeReasoning: true,
      includeToolResults: true,
    },
  },
  {
    protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
    kind: "message",
    message: {
      messageId: mapped.messages[0]!.eventId,
      sessionId: mapped.session.sessionId,
      sequence: mapped.messages[0]!.seq,
      role: mapped.messages[0]!.role,
      text: mapped.messages[0]!.text,
      timestamp: mapped.messages[0]!.ts ?? null,
      projectKey: mapped.project.projectKey,
      provider: mapped.session.provider,
      title: mapped.session.title ?? null,
      agentName: mapped.session.agentName,
      agentRole: mappedSession.session.assignmentRole ?? null,
      model: mappedSession.messages[0]!.model ?? null,
      modelProvider: mappedSession.messages[0]!.modelProvider ?? null,
      executionContextId:
        mappedSession.messages[0]!.executionContextId ?? null,
      reasoningEffort: mappedSession.messages[0]!.reasoningEffort ?? null,
    },
  },
  {
    protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
    kind: "trajectory",
    sessionId: mapped.session.sessionId,
    trajectory,
  },
  {
    protocolVersion: RESEARCH_EXPORT_PROTOCOL_VERSION,
    kind: "receipt",
    snapshot: "corpus-example:7",
    counts: { messages: 1, trajectories: 1 },
    content: {
      bytes: 42,
      sha256: `sha256:${"0".repeat(64)}`,
    },
    next: {
      sessionId: mapped.session.sessionId,
      sequence: mapped.messages[0]!.seq,
    },
  },
] as const;

describe("ResearchExportFrame v1", () => {
  test("strictly decodes every NDJSON frame shape", () => {
    for (const frame of frames) {
      expect(decodeResearchExportFrameSync(frame)).toEqual(frame);
    }
  });

  test("rejects excess fields and malformed checksums", () => {
    expect(() =>
      decodeResearchExportFrameSync({
        ...frames[0],
        generatedAt: "2026-07-27T00:00:00.000Z",
      })
    ).toThrow();
    expect(() =>
      decodeResearchExportFrameSync({
        ...frames[3],
        content: {
          ...frames[3].content,
          sha256: "not-a-checksum",
        },
      })
    ).toThrow();
  });

  test("publishes the frame contract for discovery", () => {
    expect(protocolContracts.researchExport).toMatchObject({
      schemaId: RESEARCH_EXPORT_PROTOCOL_VERSION,
      title: expect.stringContaining("research export"),
    });
    expect(
      JSON.stringify(protocolContracts.researchExport.jsonSchema),
    ).toContain('"additionalProperties":false');
  });
});
