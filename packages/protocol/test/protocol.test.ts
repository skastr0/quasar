import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import {
  HARBOR_ATIF_SCHEMA_ID,
  HARBOR_ATIF_UPSTREAM_COMMIT,
  HARBOR_ATIF_VERSION,
  NORMALIZED_SESSION_PROTOCOL_VERSION,
  RESEARCH_EXPORT_PROTOCOL_VERSION,
  QUASAR_TRAJECTORY_VERSION,
  QUERY_PROTOCOL_VERSION,
  QuerySpec,
  SESSION_ENRICHMENT_VERSION,
  decodeAtifTrajectorySync,
  decodeMappedSessionSync,
  decodeLettaTrajectorySync,
  decodeNormalizedSessionSync,
  decodeQuasarTrajectorySync,
  decodeQueryResponseSync,
  decodeQuerySpecSync,
  decodeSessionEnrichmentFiltersSync,
  decodeSessionEnrichmentPageSync,
  decodeSessionEnrichmentSync,
  projectQuasarTrajectory,
  protocolContracts,
  protocolDiscovery,
  protocolExamples,
  toAtifTrajectory,
  toLettaTrajectory,
} from "../src/index";

const searchQuery = {
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "search",
  text: "model assignment",
  mode: "fusion",
  filters: {
    projectKey: "quasar",
    providers: ["codex"],
    agentRole: "codebase-archeologist",
    modelProvider: "openai",
  },
  projection: {
    detail: "summary",
    fields: ["sessionId", "provider", "text", "score"],
  },
  page: { limit: 25 },
} as const;

describe("NormalizedSession v1", () => {
  const sourceExample = (): any =>
    structuredClone(protocolContracts.normalizedSession.examples[0].input);
  const mappedExample = (): any =>
    structuredClone(protocolContracts.mappedSession.examples[0].input);

  test("publishes and decodes source and ingest schemas", () => {
    expect(() => decodeNormalizedSessionSync(sourceExample())).not.toThrow();
    expect(() => decodeMappedSessionSync(mappedExample())).not.toThrow();
    expect(
      JSON.stringify(protocolContracts.normalizedSession.jsonSchema),
    ).toContain('"additionalProperties":false');
    expect(
      JSON.stringify(protocolContracts.mappedSession.jsonSchema),
    ).toContain('"additionalProperties":false');
  });

  test("rejects invalid roles, kinds, duplicate ids, and duplicate sequences", () => {
    const invalidRole = sourceExample();
    invalidRole.events[0] = { ...invalidRole.events[0], role: "reasoning" } as never;
    expect(() => decodeNormalizedSessionSync(invalidRole)).toThrow();

    const invalidKind = sourceExample();
    invalidKind.events[0] = { ...invalidKind.events[0], kind: "chat" } as never;
    expect(() => decodeNormalizedSessionSync(invalidKind)).toThrow();

    const duplicateId = sourceExample();
    duplicateId.events.push({
      ...duplicateId.events[0],
      sequence: 1,
    });
    duplicateId.eventCount = 2;
    expect(() => decodeNormalizedSessionSync(duplicateId)).toThrow();

    const duplicateSequence = sourceExample();
    duplicateSequence.events.push({
      ...duplicateSequence.events[0],
      id: "codex:example:event:1",
    });
    duplicateSequence.eventCount = 2;
    expect(() => decodeNormalizedSessionSync(duplicateSequence)).toThrow();
  });

  test("requires explicit normalization and source-fact counts", () => {
    const missingCount = sourceExample();
    delete missingCount.artifactCount;
    expect(() => decodeNormalizedSessionSync(missingCount)).toThrow();

    const wrongCount = sourceExample();
    wrongCount.eventCount = 2;
    expect(() => decodeNormalizedSessionSync(wrongCount)).toThrow();

    const missingNormalizationVersion = sourceExample();
    delete missingNormalizationVersion.normalizationVersion;
    expect(
      () => decodeNormalizedSessionSync(missingNormalizationVersion),
    ).toThrow();
  });

  test("rejects broken references and cross-session rows before persistence", () => {
    const brokenToolReference = sourceExample();
    brokenToolReference.events[0] = {
      ...brokenToolReference.events[0],
      toolCallId: "missing-tool-call",
    };
    expect(() => decodeNormalizedSessionSync(brokenToolReference)).toThrow();

    const brokenUsageReference = sourceExample();
    brokenUsageReference.usageRecords.push({
      id: "usage-missing-event",
      sessionId: "codex:example",
      eventId: "missing-event",
      machineId: "machine-example",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "project-example",
      inputTokens: 1,
    });
    brokenUsageReference.usageRecordCount = 1;
    expect(() => decodeNormalizedSessionSync(brokenUsageReference)).toThrow();

    const crossSession = mappedExample();
    crossSession.events[0] = {
      ...crossSession.events[0],
      sessionId: "codex:other",
    };
    expect(() => decodeMappedSessionSync(crossSession)).toThrow();
  });

  test("preserves provider-native turn ids that do not name events", () => {
    const source = sourceExample();
    source.executionContexts.push({
      id: "codex:example:execution-context:0",
      sessionId: source.id,
      machineId: source.machineId,
      provider: source.provider,
      agentName: source.agentName,
      projectIdentityKey: source.projectIdentity.projectIdentityKey,
      sequence: source.events[0].sequence,
      scope: "turn",
      turnId: "opaque-provider-turn-id",
      model: "gpt-test",
    });
    expect(() => decodeNormalizedSessionSync(source)).not.toThrow();

    const mapped = mappedExample();
    mapped.executionContexts.push({
      id: "codex:example:execution-context:0",
      sessionId: mapped.session.sessionId,
      machineId: mapped.events[0].machineId,
      provider: mapped.session.provider,
      agentName: mapped.session.agentName,
      projectIdentityKey: mapped.project.projectKey,
      sequence: mapped.events[0].sequence,
      scope: "turn",
      turnId: "opaque-provider-turn-id",
      model: "gpt-test",
    });
    expect(() => decodeMappedSessionSync(mapped)).not.toThrow();
  });

  test("fails closed on protocol version skew", () => {
    const skewed = {
      ...mappedExample(),
      protocolVersion: "quasar.normalized-session/v0",
    };
    expect(() => decodeMappedSessionSync(skewed)).toThrow();
    expect(mappedExample().protocolVersion).toBe(
      NORMALIZED_SESSION_PROTOCOL_VERSION,
    );
  });
});

describe("QuasarTrajectory v1", () => {
  const mixedSession = (): any => {
    const mapped: any = structuredClone(
      protocolContracts.mappedSession.examples[0].input,
    );
    const assistantEvent = {
      ...mapped.events[0],
      id: "codex:example:event:1",
      nativeEventId: "native-event-1",
      sequence: 1,
      timestamp: "2026-07-26T12:00:01.000Z",
      role: "assistant",
      contentText: "I will inspect both files.",
      contentBlocks: [{
        id: "codex:example:block:thinking",
        sequence: 0,
        kind: "thinking",
        thinking: "Compare both sources before answering.",
      }],
      rawReference: {
        sourcePath: "/history/example.jsonl",
        line: 2,
        nativeType: "response_item",
        rawBytes: 256,
      },
    };
    const firstResultEvent = {
      ...mapped.events[0],
      id: "codex:example:event:2",
      nativeEventId: "native-event-2",
      sequence: 2,
      timestamp: "2026-07-26T12:00:02.000Z",
      role: "tool",
      kind: "tool_result",
      contentText: "αβγ first payload",
      contentBlocks: [],
      toolCallId: "call-a",
      rawReference: {
        sourcePath: "/history/example.jsonl",
        line: 3,
        nativeType: "function_call_output",
        rawBytes: 128,
      },
    };
    const secondResultEvent = {
      ...firstResultEvent,
      id: "codex:example:event:3",
      nativeEventId: "native-event-3",
      sequence: 3,
      timestamp: "2026-07-26T12:00:03.000Z",
      contentText: "second payload",
      toolCallId: "call-b",
      rawReference: {
        sourcePath: "/history/example.jsonl",
        line: 4,
        nativeType: "function_call_output",
        rawBytes: 96,
      },
    };
    mapped.events.push(assistantEvent, firstResultEvent, secondResultEvent);
    mapped.messages.push({
      sessionId: mapped.session.sessionId,
      eventId: assistantEvent.id,
      seq: assistantEvent.sequence,
      role: "assistant",
      text: assistantEvent.contentText,
      ts: assistantEvent.timestamp,
      projectKey: mapped.project.projectKey,
      contentHash: "hash-assistant",
    });
    mapped.toolCalls.push(
      {
        id: "call-a",
        sessionId: mapped.session.sessionId,
        eventId: assistantEvent.id,
        seq: assistantEvent.sequence,
        toolName: "read",
        status: "completed",
        inputText: "{\"path\":\"a.ts\"}",
        outputText: firstResultEvent.contentText,
        startedAt: "2026-07-26T12:00:01.100Z",
        completedAt: firstResultEvent.timestamp,
        projectKey: mapped.project.projectKey,
        provider: mapped.session.provider,
      },
      {
        id: "call-b",
        sessionId: mapped.session.sessionId,
        eventId: assistantEvent.id,
        seq: assistantEvent.sequence,
        toolName: "read",
        status: "completed",
        inputText: "{\"path\":\"b.ts\"}",
        outputText: "",
        startedAt: "2026-07-26T12:00:01.200Z",
        completedAt: secondResultEvent.timestamp,
        projectKey: mapped.project.projectKey,
        provider: mapped.session.provider,
      },
    );
    mapped.session.messageCount = mapped.messages.length;
    mapped.session.toolCallCount = mapped.toolCalls.length;
    return decodeMappedSessionSync(mapped);
  };

  test("preserves mixed assistant text, reasoning, parallel calls, results, and source links deterministically", () => {
    const source = mixedSession();
    const first = projectQuasarTrajectory(source);
    const second = projectQuasarTrajectory(source);

    expect(first).toEqual(second);
    expect(first.protocolVersion).toBe(QUASAR_TRAJECTORY_VERSION);
    expect(first.records.map((record) => record.role)).toEqual([
      "meta",
      "user",
      "reasoning",
      "assistant",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ]);
    expect(first.records.find((record) =>
      record.role === "assistant"
    )).toEqual(expect.objectContaining({
      content: "I will inspect both files.",
      sourceEventId: "codex:example:event:1",
    }));
    expect(first.records.filter((record) =>
      record.role === "tool_call"
    ).map((record) => record.toolCallId)).toEqual(["call-a", "call-b"]);
    expect(first.records.filter((record) =>
      record.role === "tool_result"
    ).map((record) => record.toolCallId)).toEqual(["call-a", "call-b"]);
    expect(first.records.find((record) =>
      record.role === "tool_result" && record.toolCallId === "call-b"
    )).toEqual(expect.objectContaining({ content: "second payload" }));
    expect(first.records.every((record, index) =>
      record.sequence === index
      && record.fullRead.sessionId === source.session.sessionId
    )).toBe(true);
    expect(() => decodeQuasarTrajectorySync(first)).not.toThrow();
  });

  test("reports caller-selected omissions and UTF-8-safe truncation with a targeted full-read pointer", () => {
    const trajectory = projectQuasarTrajectory(mixedSession(), {
      includeReasoning: false,
      includeToolResults: true,
      toolResultMaxBytes: 5,
    });

    expect(trajectory.records.some((record) =>
      record.role === "reasoning"
    )).toBe(false);
    const result = trajectory.records.find((record) =>
      record.role === "tool_result" && record.toolCallId === "call-a"
    );
    expect(result).toEqual(expect.objectContaining({
      content: "αβ",
      originalBytes: Buffer.byteLength("αβγ first payload"),
      returnedBytes: 4,
      truncated: true,
      fullRead: expect.objectContaining({
        resource: "tool-call",
        toolCallId: "call-a",
      }),
    }));
    expect(trajectory.losses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "omitted",
        sourceKind: "content_block",
        reason: "excluded_by_option",
      }),
      expect.objectContaining({
        kind: "truncated",
        sourceId: "call-a",
        originalBytes: Buffer.byteLength("αβγ first payload"),
        returnedBytes: 4,
      }),
    ]));
  });

  test("exports strict Letta v1 while declaring mixed-event and timestamp loss", () => {
    const exported = toLettaTrajectory(
      projectQuasarTrajectory(mixedSession()),
    );

    expect(() => decodeLettaTrajectorySync(exported.trajectory)).not.toThrow();
    expect(exported.trajectory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: "I will inspect both files.",
      }),
      expect.objectContaining({
        role: "assistant",
        content: null,
        tool_calls: [
          expect.objectContaining({ id: "call-a", name: "read" }),
          expect.objectContaining({ id: "call-b", name: "read" }),
        ],
      }),
    ]));
    expect(exported.compatibility.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining([
        "mixed_assistant_split",
        "tool_call_timestamps_coalesced",
      ]),
    );
  });

  test("exports mixed tools, exact usage, and embedded subagents as pinned ATIF-v1.7", () => {
    const parentValue: any = structuredClone(mixedSession());
    const assistantEvent = parentValue.events.find((event: any) =>
      event.id === "codex:example:event:1"
    );
    parentValue.usageRecords.push({
      id: "usage-assistant",
      sessionId: parentValue.session.sessionId,
      eventId: assistantEvent.id,
      machineId: assistantEvent.machineId,
      provider: parentValue.session.provider,
      agentName: parentValue.session.agentName,
      projectIdentityKey: parentValue.session.projectKey,
      timestamp: assistantEvent.timestamp,
      model: "gpt-test",
      modelProvider: "openai",
      inputTokens: 42,
      outputTokens: 12,
      reasoningTokens: 5,
      cacheReadInputTokens: 7,
      totalTokens: 54,
      cost: 0.01,
      currency: "USD",
    });
    const userEvent = parentValue.events[0];
    parentValue.usageRecords.push({
      id: "usage-user-event",
      sessionId: parentValue.session.sessionId,
      eventId: userEvent.id,
      machineId: userEvent.machineId,
      provider: parentValue.session.provider,
      agentName: parentValue.session.agentName,
      projectIdentityKey: parentValue.session.projectKey,
      inputTokens: 3,
    });
    const parent = decodeMappedSessionSync(parentValue);

    const childValue: any = structuredClone(
      protocolContracts.mappedSession.examples[0].input,
    );
    const childSessionId = "codex:example:child";
    const childEventId = "codex:example:child:event:0";
    childValue.session.sessionId = childSessionId;
    childValue.session.parentSessionId = parent.session.sessionId;
    childValue.session.sourcePath = "/history/child.jsonl";
    childValue.session.sourceFingerprint = "child-fingerprint";
    childValue.events[0].id = childEventId;
    childValue.events[0].sessionId = childSessionId;
    childValue.events[0].nativeEventId = "child-native-event-0";
    childValue.events[0].rawReference.sourcePath = "/history/child.jsonl";
    childValue.messages[0].sessionId = childSessionId;
    childValue.messages[0].eventId = childEventId;
    childValue.sessionEdges = [{
      id: "edge-parent-child",
      sessionId: childSessionId,
      machineId: childValue.events[0].machineId,
      provider: childValue.session.provider,
      agentName: childValue.session.agentName,
      projectIdentityKey: childValue.session.projectKey,
      kind: "subagent_of",
      fromId: parent.session.sessionId,
      toId: childSessionId,
    }];
    const child = decodeMappedSessionSync(childValue);

    const exported = toAtifTrajectory(parent, {
      subagentSessions: [child],
    });
    expect(exported.schemaVersion).toBe(HARBOR_ATIF_VERSION);
    expect(exported.schemaId).toBe(HARBOR_ATIF_SCHEMA_ID);
    expect(exported.schemaSource.commit).toBe(HARBOR_ATIF_UPSTREAM_COMMIT);
    expect(() => decodeAtifTrajectorySync(exported.trajectory)).not.toThrow();

    const assistantStep: any = exported.trajectory.steps.find((step: any) =>
      step.extra?.quasar?.source_event_id === assistantEvent.id
    );
    expect(assistantStep).toEqual(expect.objectContaining({
      source: "agent",
      message: "I will inspect both files.",
      reasoning_content: "Compare both sources before answering.",
      metrics: expect.objectContaining({
        prompt_tokens: 42,
        completion_tokens: 12,
        cached_tokens: 7,
        cost_usd: 0.01,
      }),
    }));
    expect(assistantStep.tool_calls.map((call: any) =>
      call.tool_call_id
    )).toEqual(["call-a", "call-b"]);
    expect(assistantStep.observation.results.map((result: any) =>
      result.content
    )).toEqual(["αβγ first payload", "second payload"]);
    expect(exported.trajectory.final_metrics).toEqual({
      total_steps: exported.trajectory.steps.length,
    });
    const userStep: any = exported.trajectory.steps.find((step: any) =>
      step.extra?.quasar?.source_event_id === userEvent.id
    );
    expect(userStep.metrics).toBeUndefined();
    expect(userStep.extra.quasar.usage_records).toEqual([
      expect.objectContaining({
        id: "usage-user-event",
        inputTokens: 3,
      }),
    ]);

    const childTrajectory = exported.trajectory.subagent_trajectories?.[0];
    expect(childTrajectory?.trajectory_id).toBe(childSessionId);
    const relationshipStep: any = exported.trajectory.steps.at(-1);
    expect(
      relationshipStep.observation.results[0].subagent_trajectory_ref[0],
    ).toEqual(expect.objectContaining({
      trajectory_id: childSessionId,
      session_id: childSessionId,
    }));
    expect(exported.compatibility.counts).toEqual(expect.objectContaining({
      sourceSessions: 2,
      embeddedSubagents: 1,
      sourceUsageRecords: 2,
      sourceSessionEdges: 1,
    }));
    expect(exported.compatibility.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "mapped_core",
        sourceKind: "usage_record",
        sourceId: "usage-assistant",
      }),
      expect.objectContaining({
        status: "mapped_extension",
        sourceKind: "usage_record",
        sourceId: "usage-user-event",
      }),
      expect.objectContaining({
        status: "mapped_core",
        sourceKind: "session_edge",
        sourceId: "edge-parent-child",
      }),
      expect.objectContaining({
        status: "unobserved_atif_field",
        targetPath: "trajectory.agent.version",
      }),
    ]));
    expect(exported.compatibility.entries.filter((entry) =>
      entry.sourceKind === "session_edge"
      && entry.sourceId === "edge-parent-child"
    )).toHaveLength(1);

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(
      protocolContracts.harborAtif.jsonSchema as object,
    );
    expect(validate(exported.trajectory), JSON.stringify(validate.errors))
      .toBe(true);
    expect(
      (protocolContracts.harborAtif.jsonSchema as any)["x-harbor-source"]
        .commit,
    ).toBe(HARBOR_ATIF_UPSTREAM_COMMIT);
  });

  test("keeps ATIF policy omissions and truncation from leaking through extensions", () => {
    const exported = toAtifTrajectory(mixedSession(), {
      includeReasoning: false,
      includeToolResults: true,
      toolResultMaxBytes: 5,
    });
    const serialized = JSON.stringify(exported.trajectory);
    expect(serialized).not.toContain(
      "Compare both sources before answering.",
    );
    expect(serialized).not.toContain("αβγ first payload");
    const assistantStep: any = exported.trajectory.steps.find((step: any) =>
      step.tool_calls?.length === 2
    );
    expect(assistantStep.reasoning_content).toBeUndefined();
    expect(assistantStep.observation.results[0]).toEqual(
      expect.objectContaining({ content: "αβ" }),
    );
    expect(exported.compatibility.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "omitted_by_policy",
        sourceKind: "content_block",
      }),
      expect.objectContaining({
        status: "projection_adjustment",
        sourceKind: "tool_result",
        sourceId: "call-a",
      }),
    ]));
  });

  test("keeps opaque provider turn contexts in the ATIF source extension", () => {
    const value: any = structuredClone(mixedSession());
    const sourceEvent = value.events[1];
    value.executionContexts.push({
      id: "codex:example:execution-context:opaque",
      sessionId: value.session.sessionId,
      machineId: sourceEvent.machineId,
      provider: value.session.provider,
      agentName: value.session.agentName,
      projectIdentityKey: value.project.projectKey,
      sequence: sourceEvent.sequence,
      scope: "turn",
      turnId: "opaque-provider-turn-id",
      model: "gpt-context",
    });
    const exported = toAtifTrajectory(decodeMappedSessionSync(value));
    const step: any = exported.trajectory.steps.find((candidate: any) =>
      candidate.extra?.quasar?.source_event_id === sourceEvent.id
    );

    expect(step.extra.quasar.execution_contexts).toEqual([
      expect.objectContaining({
        id: "codex:example:execution-context:opaque",
        turnId: "opaque-provider-turn-id",
      }),
    ]);
    expect(exported.compatibility.entries).toContainEqual(
      expect.objectContaining({
        status: "mapped_extension",
        sourceKind: "execution_context",
        sourceId: "codex:example:execution-context:opaque",
      }),
    );
  });

  test("rejects ATIF semantic corruption beyond JSON field shape", () => {
    const sequential: any = structuredClone(
      toAtifTrajectory(mixedSession()).trajectory,
    );
    sequential.steps[1].step_id = 99;
    expect(() => decodeAtifTrajectorySync(sequential)).toThrow();

    const sourceFields: any = structuredClone(
      toAtifTrajectory(mixedSession()).trajectory,
    );
    sourceFields.steps[0].model_name = "not-valid-on-user";
    expect(() => decodeAtifTrajectorySync(sourceFields)).toThrow();

    const unresolved: any = structuredClone(
      toAtifTrajectory(mixedSession()).trajectory,
    );
    unresolved.steps.push({
      step_id: unresolved.steps.length + 1,
      source: "system",
      message: "",
      observation: {
        results: [{
          subagent_trajectory_ref: [{ trajectory_id: "missing-child" }],
        }],
      },
    });
    expect(() => decodeAtifTrajectorySync(unresolved)).toThrow();
  });

  test("rejects sequence and tool-result reference corruption", () => {
    const trajectory: any = structuredClone(
      projectQuasarTrajectory(mixedSession()),
    );
    trajectory.records[1].sequence = 9;
    expect(() => decodeQuasarTrajectorySync(trajectory)).toThrow();

    const brokenReference: any = structuredClone(
      projectQuasarTrajectory(mixedSession()),
    );
    const result: any = brokenReference.records.find((record: any) =>
      record.role === "tool_result"
    );
    result.toolCallId = "missing-call";
    expect(() => decodeQuasarTrajectorySync(brokenReference)).toThrow();
  });
});

describe("QuerySpec v1", () => {
  test("accepts every registered query example", () => {
    for (const example of protocolContracts.query.examples) {
      expect(() => decodeQuerySpecSync(example.input)).not.toThrow();
    }
  });

  test("rejects unknown properties at every boundary", () => {
    expect(() => decodeQuerySpecSync({ ...searchQuery, surprise: true })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      filters: { ...searchQuery.filters, surprise: true },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      projection: { ...searchQuery.projection, surprise: true },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: { surprise: true },
      projection: { detail: "summary", fields: ["text"] },
      page: { limit: 10 },
    })).toThrow();
  });

  test("rejects invalid kind-specific combinations", () => {
    expect(() => decodeQuerySpecSync({ ...searchQuery, text: "   " })).toThrow();
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: { sessionId: "   " },
      projection: { detail: "summary", fields: ["text"] },
      page: { limit: 10 },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "sessions",
      text: "not valid for sessions",
      projection: { detail: "summary", fields: ["sessionId"] },
      page: { limit: 10 },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: {
        sessionId: "codex:example-session",
        toolName: "exec_command",
      },
      projection: { detail: "summary", fields: ["text"] },
      page: { limit: 10 },
    })).toThrow();
  });

  test("accepts unfiltered corpus scans and every optional message filter", () => {
    const projection = {
      detail: "detail",
      fields: [
        "messageId",
        "sessionId",
        "role",
        "text",
        "projectKey",
        "provider",
        "agentName",
        "agentRole",
        "model",
        "modelProvider",
      ],
    } as const;
    const unfiltered = decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      projection,
      page: { limit: 100 },
    });
    expect(unfiltered.kind).toBe("messages");
    if (unfiltered.kind === "messages") {
      expect(unfiltered.filters).toBeUndefined();
    }

    const filtered = decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: {
        sessionId: "codex:child-session",
        projectKey: "quasar",
        providers: ["codex", "claude"],
        role: "user",
        agentName: "codex",
        agentRole: "builder",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        messageAfter: "2026-07-01T00:00:00.000Z",
        messageBefore: "2026-08-01T00:00:00.000Z",
        sessionStartedAfter: "2026-06-01T00:00:00.000Z",
        sessionStartedBefore: "2026-08-01T00:00:00.000Z",
        rootsOnly: false,
        lineageRootSessionId: "codex:root-session",
      },
      projection,
      page: { limit: 100 },
    });
    expect(filtered.kind).toBe("messages");
    if (filtered.kind === "messages") {
      expect(JSON.parse(JSON.stringify(filtered.filters))).toEqual({
        sessionId: "codex:child-session",
        projectKey: "quasar",
        providers: ["codex", "claude"],
        role: "user",
        agentName: "codex",
        agentRole: "builder",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        messageAfter: "2026-07-01T00:00:00.000Z",
        messageBefore: "2026-08-01T00:00:00.000Z",
        sessionStartedAfter: "2026-06-01T00:00:00.000Z",
        sessionStartedBefore: "2026-08-01T00:00:00.000Z",
        rootsOnly: false,
        lineageRootSessionId: "codex:root-session",
      });
    }
  });

  test("rejects inverted message and session time ranges", () => {
    const base = {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      projection: { detail: "summary", fields: ["messageId", "text"] },
      page: { limit: 10 },
    } as const;
    expect(() => decodeQuerySpecSync({
      ...base,
      filters: {
        messageAfter: "2026-08-01T00:00:00.000Z",
        messageBefore: "2026-07-01T00:00:00.000Z",
      },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...base,
      filters: {
        sessionStartedAfter: "2026-08-01T00:00:00.000Z",
        sessionStartedBefore: "2026-07-01T00:00:00.000Z",
      },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...base,
      filters: {
        messageAfter: "2026-07-01T00:00:00.000Z",
        messageBefore: "2026-07-01T00:00:00.000Z",
        sessionStartedAfter: "2026-07-01T00:00:00.000Z",
        sessionStartedBefore: "2026-07-01T00:00:00.000Z",
      },
    })).not.toThrow();
  });

  test("keeps assignment role distinct from message role", () => {
    const decoded = decodeQuerySpecSync(searchQuery);
    expect(decoded.kind).toBe("search");
    if (decoded.kind === "search") {
      expect(decoded.filters?.role).toBeUndefined();
      expect(decoded.filters?.agentRole).toBe("codebase-archeologist");
      expect(decoded.filters?.modelProvider).toBe("openai");
    }
  });

  test("accepts the normalized reasoning message role", () => {
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: {
        sessionId: "codex:example-session",
        role: "reasoning",
      },
      projection: {
        detail: "summary",
        fields: ["messageId", "role", "text"],
      },
      page: { limit: 10 },
    })).not.toThrow();

    expect(() => decodeQueryResponseSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      projection: {
        detail: "summary",
        fields: ["messageId", "role", "text"],
      },
      page: { returned: 1 },
      items: [{
        messageId: "codex:message:reasoning",
        role: "reasoning",
        text: "private chain omitted; normalized reasoning summary retained",
      }],
    })).not.toThrow();
  });

  test("exposes session provenance and search excerpt metadata in detail projections", () => {
    const sessionProjection = {
      detail: "detail",
      fields: [
        "sessionId",
        "sourcePath",
        "sourceFingerprint",
        "host",
        "identitySchemeVersion",
        "normalizationVersion",
      ],
    } as const;
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "sessions",
      projection: sessionProjection,
      page: { limit: 10 },
    })).not.toThrow();
    expect(() => decodeQueryResponseSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "sessions",
      projection: sessionProjection,
      page: { returned: 1 },
      items: [{
        sessionId: "codex:example-session",
        sourcePath: "/history/example.jsonl",
        sourceFingerprint: "{\"size\":42}",
        host: "example.local",
        identitySchemeVersion: 1,
        normalizationVersion: 4,
      }],
    })).not.toThrow();

    const searchProjection = {
      detail: "detail",
      fields: ["messageId", "text", "contentHash", "textBytes", "textTruncated"],
    } as const;
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      projection: searchProjection,
    })).not.toThrow();
    expect(() => decodeQueryResponseSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "search",
      projection: searchProjection,
      page: { returned: 1 },
      items: [{
        messageId: "codex:example-session:1",
        text: "bounded excerpt",
        contentHash: "sha256-example",
        textBytes: 9_001,
        textTruncated: true,
      }],
    })).not.toThrow();
  });

  test("rejects raw event roles from message queries", () => {
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: {
        sessionId: "codex:example-session",
        role: "tool",
      },
      projection: {
        detail: "summary",
        fields: ["messageId", "role", "text"],
      },
      page: { limit: 10 },
    })).toThrow();
  });

  test("requires tool payload fields to use detail projection", () => {
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "toolCalls",
      projection: { detail: "summary", fields: ["toolCallId", "output"] },
      page: { limit: 10 },
    })).toThrow();

    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "toolCalls",
      projection: { detail: "detail", fields: ["toolCallId", "output"] },
      page: { limit: 10 },
    })).not.toThrow();
  });

  test("bounds pagination and projection", () => {
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      page: { limit: 0 },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      page: { limit: 201 },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      projection: { detail: "summary", fields: ["text", "text"] },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      page: { limit: 10, cursor: "   " },
    })).toThrow();
  });

  test("keeps request and response cursors opaque", () => {
    const cursor = "snapshot=v7/messages:eyJzZXEiOjQyfQ==?not-client-decoded";
    const request = decodeQuerySpecSync({
      ...searchQuery,
      page: { limit: 10, cursor },
    });
    expect(String(request.page.cursor)).toBe(cursor);

    const response = decodeQueryResponseSync({
      ...protocolContracts.response.examples[0].input,
      page: {
        ...protocolContracts.response.examples[0].input.page,
        nextCursor: cursor,
      },
    });
    expect(String(response.page.nextCursor)).toBe(cursor);
  });

  test("publishes a closed JSON Schema", () => {
    const schema = protocolContracts.query.jsonSchema as {
      readonly $defs?: Record<string, unknown>;
      readonly anyOf?: ReadonlyArray<{ readonly additionalProperties?: boolean }>;
    };
    expect(schema.$defs).toBeDefined();
    expect(JSON.stringify(schema)).toContain('"additionalProperties":false');
    expect(QuerySpec.ast).toBeDefined();
  });
});

describe("QueryResponse v1", () => {
  test("accepts every registered response example", () => {
    for (const example of protocolContracts.response.examples) {
      expect(() => decodeQueryResponseSync(example.input)).not.toThrow();
    }
  });

  test("requires each row to match the selected fields exactly", () => {
    const response = protocolContracts.response.examples[0].input;
    expect(() => decodeQueryResponseSync(response)).not.toThrow();
    expect(() => decodeQueryResponseSync({
      ...response,
      items: [{ ...response.items[0], title: "not selected" }],
    })).toThrow();
    expect(() => decodeQueryResponseSync({
      ...response,
      page: { ...response.page, returned: 2 },
    })).toThrow();
  });

  test("represents requested missing metadata as explicit null", () => {
    const response = {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "sessions",
      projection: {
        detail: "detail",
        fields: [
          "sessionId",
          "title",
          "model",
          "modelProvider",
          "agentRole",
          "endedAt",
        ],
      },
      page: { returned: 1 },
      items: [{
        sessionId: "codex:example-session",
        title: null,
        model: null,
        modelProvider: null,
        agentRole: null,
        endedAt: null,
      }],
    } as const;

    expect(() => decodeQueryResponseSync(response)).not.toThrow();
    expect(() => decodeQueryResponseSync({
      ...response,
      items: [{ ...response.items[0], sessionId: null }],
    })).toThrow();

    expect(() => decodeQueryResponseSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "toolCalls",
      projection: {
        detail: "detail",
        fields: ["toolCallId", "model", "startedAt", "input", "output", "error"],
      },
      page: { returned: 1 },
      items: [{
        toolCallId: "call_example",
        model: null,
        startedAt: null,
        input: null,
        output: null,
        error: null,
      }],
    })).not.toThrow();
  });

  test("keeps tool bodies out of summary rows", () => {
    const response = protocolContracts.response.examples[1].input;
    expect(response.items[0].inputBytes).toBe(128);
    expect(response.items[0].outputBytes).toBe(2_048);
    expect("input" in response.items[0]).toBe(false);
    expect("output" in response.items[0]).toBe(false);
    expect(() => decodeQueryResponseSync({
      ...response,
      items: [{ ...response.items[0], output: "body" }],
    })).toThrow();
  });
});

describe("SessionEnrichment v1", () => {
  test("keeps derived analysis in a separate strict envelope", () => {
    const enrichment = protocolContracts.sessionEnrichment.examples[0].input;
    expect(() => decodeSessionEnrichmentSync(enrichment)).not.toThrow();
    expect(() => decodeSessionEnrichmentSync({
      ...enrichment,
      sourceFacts: { model: "must remain elsewhere" },
    })).toThrow();
    expect(() => decodeSessionEnrichmentSync({
      ...enrichment,
      payload: 1n,
    })).toThrow();
  });

  test("is discoverable from the same registry as query contracts", () => {
    expect(protocolDiscovery.map((entry) => entry.schemaId)).toEqual([
      NORMALIZED_SESSION_PROTOCOL_VERSION,
      "quasar.normalized-session-ingest/v1",
      QUASAR_TRAJECTORY_VERSION,
      "quasar.trajectory.letta-export/v1",
      HARBOR_ATIF_SCHEMA_ID,
      "quasar.trajectory.atif-export/v1",
      RESEARCH_EXPORT_PROTOCOL_VERSION,
      QUERY_PROTOCOL_VERSION,
      "quasar.query-response/v1",
      SESSION_ENRICHMENT_VERSION,
    ]);
    expect(protocolExamples.length).toBe(14);
    expect(protocolExamples.every((example) => example.schemaId.length > 0)).toBe(true);
  });

  test("strictly types exact enumeration filters and bounded pages", () => {
    const enrichment = protocolContracts.sessionEnrichment.examples[0].input;
    const filters = decodeSessionEnrichmentFiltersSync({
      projectKey: "quasar",
      sessionId: enrichment.sessionId,
      namespace: enrichment.namespace,
      producer: enrichment.producer,
      inputHash: enrichment.inputHash,
    });
    expect(String(filters.projectKey)).toBe("quasar");
    expect(String(filters.sessionId)).toBe(enrichment.sessionId);
    expect(filters.namespace).toBe(enrichment.namespace);
    expect(filters.producer).toBe(enrichment.producer);
    expect(filters.inputHash).toBe(enrichment.inputHash);
    expect(() => decodeSessionEnrichmentFiltersSync({
      namespace: enrichment.namespace,
      payload: "not a filter",
    })).toThrow();

    expect(() => decodeSessionEnrichmentPageSync({
      rows: [enrichment],
      page: { returned: 1, nextCursor: "opaque-cursor" },
    })).not.toThrow();
    expect(() => decodeSessionEnrichmentPageSync({
      rows: [enrichment],
      page: { returned: 0 },
    })).toThrow();
  });
});
