import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { configuredServerUrl, defaultClientConfigPath, loadClientConfig } from "../src/client-config";

describe("client config", () => {
  test("resolves the default config path from QUASAR_CONFIG", () => {
    expect(defaultClientConfigPath({ QUASAR_CONFIG: "/tmp/quasar-config.json" })).toBe("/tmp/quasar-config.json");
  });

  test("loads only supported local-server URL fields from config", () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-client-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ localServerUrl: " http://127.0.0.1:6180 ", legacyApiUrl: "ignored" }));

    expect(loadClientConfig(path)).toEqual({
      localServerUrl: "http://127.0.0.1:6180",
      apiUrl: undefined,
      url: undefined,
    });
  });

  test("uses explicit env before config and config before local embedded mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-client-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ localServerUrl: "http://config:6180", apiUrl: "http://api:6180", url: "http://url:6180" }));

    expect(configuredServerUrl({ QUASAR_CONFIG: path })).toBe("http://config:6180");
    expect(configuredServerUrl({ QUASAR_CONFIG: path, QUASAR_LOCAL_SERVER_URL: " http://env:6180 " })).toBe("http://env:6180");
    expect(configuredServerUrl({ QUASAR_CONFIG: join(dir, "missing.json") })).toBeUndefined();
  });

  test("falls back from localServerUrl to apiUrl to url", () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-client-config-"));
    const apiPath = join(dir, "api.json");
    const urlPath = join(dir, "url.json");
    writeFileSync(apiPath, JSON.stringify({ apiUrl: "http://api:6180", url: "http://url:6180" }));
    writeFileSync(urlPath, JSON.stringify({ url: "http://url:6180" }));

    expect(configuredServerUrl({ QUASAR_CONFIG: apiPath })).toBe("http://api:6180");
    expect(configuredServerUrl({ QUASAR_CONFIG: urlPath })).toBe("http://url:6180");
  });
});
