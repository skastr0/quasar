import { describe, expect, test } from "bun:test";

import { WriteReceipt } from "../src/lancedb";

// T3 — the write returns evidence, not void. The proven incident (29 requested,
// 27 applied) is a value with a non-zero shortfall and complete === false, so a
// caller cannot mistake a short write for a full one.
describe("WriteReceipt", () => {
  test("a short write (the 27-of-29 incident) is incomplete with the exact shortfall", () => {
    const r = new WriteReceipt({ table: "messages", requested: 29, inserted: 25, updated: 2, deleted: 0 });
    expect(r.applied).toBe(27);
    expect(r.shortfall).toBe(2);
    expect(r.complete).toBe(false);
  });

  test("a full fresh insert is complete with zero shortfall", () => {
    const r = new WriteReceipt({ table: "messages", requested: 29, inserted: 29, updated: 0, deleted: 0 });
    expect(r.applied).toBe(29);
    expect(r.shortfall).toBe(0);
    expect(r.complete).toBe(true);
  });

  test("a full re-index (all updates) is complete", () => {
    const r = new WriteReceipt({ table: "messages", requested: 29, inserted: 0, updated: 29, deleted: 0 });
    expect(r.applied).toBe(29);
    expect(r.complete).toBe(true);
  });

  test("an unexpected delete makes the receipt incomplete even at full applied count", () => {
    const r = new WriteReceipt({ table: "messages", requested: 2, inserted: 2, updated: 0, deleted: 1 });
    expect(r.complete).toBe(false);
  });

  test("an empty write is vacuously complete", () => {
    const r = new WriteReceipt({ table: "messages", requested: 0, inserted: 0, updated: 0, deleted: 0 });
    expect(r.shortfall).toBe(0);
    expect(r.complete).toBe(true);
  });
});
