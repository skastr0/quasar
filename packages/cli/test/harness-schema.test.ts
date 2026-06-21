import { Schema } from "effect";

import { describe, expect, test } from "bun:test";

import {
  decodeOrDrop,
  drop,
  isSignal,
  signal,
  type DecodeDiagnostic,
} from "../src/adapters/harness-schema";

const Record = Schema.Struct({
  id: Schema.String,
  seq: Schema.Number,
});

describe("harness-schema: SignalDecision base", () => {
  test("signal carries kind + value; isSignal narrows it", () => {
    const decision = signal("message", { id: "a", seq: 1 });
    expect(decision._tag).toBe("signal");
    expect(isSignal(decision)).toBe(true);
    if (isSignal(decision)) {
      expect(decision.kind).toBe("message");
      expect(decision.value.id).toBe("a");
    }
  });

  test("drop carries a named reason and is not a signal", () => {
    const decision = drop("hermes.row.unsupported_role");
    expect(decision._tag).toBe("drop");
    expect(isSignal(decision)).toBe(false);
    if (decision._tag === "drop") {
      expect(decision.reason).toBe("hermes.row.unsupported_role");
    }
  });
});

describe("harness-schema: decodeOrDrop fail-closed", () => {
  test("valid record decodes to a signal with the mapped kind", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    const decision = decodeOrDrop(Record, { id: "x", seq: 3 }, {
      kind: "message",
      diagnosticName: "test.record.decode_failed",
      diagnostics,
    });
    expect(decision._tag).toBe("signal");
    if (isSignal(decision)) {
      expect(decision.kind).toBe("message");
      expect(decision.value).toEqual({ id: "x", seq: 3 });
    }
    expect(diagnostics).toHaveLength(0);
  });

  test("malformed record becomes a NAMED drop, never a throw, never coercion", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    let decision: ReturnType<typeof decodeOrDrop>;
    expect(() => {
      decision = decodeOrDrop(Record, { id: 42, seq: "nope" }, {
        kind: "message",
        diagnosticName: "test.record.decode_failed",
        diagnostics,
      });
    }).not.toThrow();
    expect(decision!._tag).toBe("drop");
    if (decision!._tag === "drop") {
      expect(decision!.reason).toContain("test.record.decode_failed");
    }
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.name).toBe("test.record.decode_failed");
    expect(diagnostics[0]?.message.length).toBeGreaterThan(0);
  });

  test("a wholly-wrong shape (non-record) also drops, not throws", () => {
    const decision = decodeOrDrop(Record, "garbage", {
      kind: "message",
      diagnosticName: "test.record.decode_failed",
    });
    expect(decision._tag).toBe("drop");
  });
});
