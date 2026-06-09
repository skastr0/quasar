import { describe, expect, test } from "vitest";

import { stableCanonicalJsonHash } from "../src/hash";

describe("stable canonical JSON hash", () => {
  test("ignores object key order but preserves array order", () => {
    expect(stableCanonicalJsonHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableCanonicalJsonHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(stableCanonicalJsonHash(["a", "b"])).not.toBe(
      stableCanonicalJsonHash(["b", "a"]),
    );
  });
});
