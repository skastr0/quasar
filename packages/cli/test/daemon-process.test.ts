import { describe, expect, test } from "bun:test";

import { daemonIngestProcess, daemonPlist, plistEnablesAmpIngest } from "../src/daemon-process";

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

describe("daemon plist", () => {
  const options = {
    label: "com.quasar.remote-ingest",
    binary: "/opt/quasar/bin/quasar",
    serverUrl: "http://127.0.0.1:7180",
    ingestToken: "secret-token",
    intervalSeconds: 60,
    home: "/Users/dev/.config/quasar",
    stdout: "/Users/dev/.config/quasar/logs/out.log",
    stderr: "/Users/dev/.config/quasar/logs/err.log",
  };

  test("amp ingest is off unless the installer opted in", () => {
    const plist = daemonPlist({ ...options, ampIngest: false });
    expect(plist).not.toContain("QUASAR_AMP_INGEST");
    expect(plistEnablesAmpIngest(plist)).toBe(false);
  });

  test("--amp writes the QUASAR_AMP_INGEST switch into the LaunchAgent environment", () => {
    const plist = daemonPlist({ ...options, ampIngest: true });
    expect(plist).toContain("<key>QUASAR_AMP_INGEST</key>\n    <string>on</string>");
    expect(plistEnablesAmpIngest(plist)).toBe(true);
    expect(plist).toContain("<integer>60</integer>");
  });
});
