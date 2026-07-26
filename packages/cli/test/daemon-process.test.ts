import { describe, expect, test } from "bun:test";

import { daemonIngestProcess } from "../src/daemon-process";

describe("daemon ingest child process", () => {
  test("passes the ingest token only through the child environment", () => {
    const child = daemonIngestProcess(
      "http://127.0.0.1:7180",
      "secret-token",
      { NODE_ENV: "test" },
    );

    expect(child.args).toEqual([
      "ingest",
      "--provider",
      "all",
      "--summary",
      "--server",
      "http://127.0.0.1:7180",
    ]);
    expect(child.args).not.toContain("secret-token");
    expect(child.env.NODE_ENV).toBe("test");
    expect(child.env.QUASAR_INGEST_TOKEN).toBe("secret-token");
  });
});
