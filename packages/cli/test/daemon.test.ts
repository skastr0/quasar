import { describe, expect, test } from "bun:test";

import { renderLaunchAgentPlist } from "../src/commands/daemon";

describe("daemon LaunchAgent", () => {
  test("renders a periodic incremental ingest plist without embedding commands", () => {
    const plist = renderLaunchAgentPlist({
      command: ["/Users/example/.local/bin/quasar"],
      intervalSeconds: 300,
      env: {
        HOME: "/Users/example",
        QUASAR_HOME: "/Users/example/.config/quasar",
        QUASAR_DAEMON_PATH: "/custom/bin:/usr/bin:/bin",
        QUASAR_USE_FALLBACK_URL: "1",
      },
    });

    expect(plist).toContain("<string>com.guilhermecastro.quasar.ingest</string>");
    expect(plist).toContain("<string>/Users/example/.local/bin/quasar</string>");
    expect(plist).toContain("<string>ingest</string>");
    expect(plist).toContain("<string>--provider</string>");
    expect(plist).toContain("<string>all</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>300</integer>");
    expect(plist).toContain("<key>QUASAR_HOME</key>");
    expect(plist).toContain("/Users/example/.config/quasar");
    expect(plist).toContain("<key>QUASAR_USE_FALLBACK_URL</key>");
    expect(plist).not.toContain("embed");
    expect(plist).not.toContain("force");
  });
});
