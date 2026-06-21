import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { configuredIngestToken, configuredServerUrl, defaultClientConfigPath, loadClientConfig } from "../src/client-config";

describe("client config", () => {
  test("resolves the default config path from QUASAR_CONFIG", () => {
    expect(defaultClientConfigPath({ QUASAR_CONFIG: "/tmp/quasar-config.json" })).toBe("/tmp/quasar-config.json");
  });

  test("loads only supported local-server URL fields from config", () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-client-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ localServerUrl: " http://127.0.0.1:6180 ", ingestToken: " secret ", legacyApiUrl: "ignored" }));

    expect(loadClientConfig(path)).toEqual({
      localServerUrl: "http://127.0.0.1:6180",
      ingestToken: "secret",
    });
  });

  test("uses explicit env before config and otherwise returns undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-client-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ localServerUrl: "http://config:6180" }));

    expect(configuredServerUrl({ QUASAR_CONFIG: path })).toBe("http://config:6180");
    expect(configuredServerUrl({ QUASAR_CONFIG: path, QUASAR_LOCAL_SERVER_URL: " http://env:6180 " })).toBe("http://env:6180");
    expect(configuredServerUrl({ QUASAR_CONFIG: join(dir, "missing.json") })).toBeUndefined();
  });

  test("uses explicit ingest token env before config and otherwise returns undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-client-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ ingestToken: "config-token" }));

    expect(configuredIngestToken({ QUASAR_CONFIG: path })).toBe("config-token");
    expect(configuredIngestToken({ QUASAR_CONFIG: path, QUASAR_INGEST_TOKEN: " env-token " })).toBe("env-token");
    expect(configuredIngestToken({ QUASAR_CONFIG: join(dir, "missing.json") })).toBeUndefined();
  });

  test("ignores legacy URL aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-client-config-"));
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify({ serviceUrl: "http://service:6180", tailnetServerUrl: "http://tailnet:6180", token: "ignored" }));

    expect(loadClientConfig(path)).toEqual({});
    expect(configuredServerUrl({ QUASAR_CONFIG: path })).toBeUndefined();
  });
});
