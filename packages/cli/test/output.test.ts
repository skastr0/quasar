import { describe, expect, test } from "vitest";

import { renderSuccessEnvelope } from "../src/output";

describe("output envelopes", () => {
  test("renders stable success JSON", () => {
    expect(JSON.parse(renderSuccessEnvelope("doctor", { status: "ok" }))).toEqual({
      ok: true,
      command: "doctor",
      data: { status: "ok" },
    });
  });
});
