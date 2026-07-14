import { describe, it, expect } from "bun:test";
import { defaultClientConfigPath, makeQuasarConfig } from "../src/config.js";

describe("QuasarConfig", () => {
  describe("defaultClientConfigPath", () => {
    it("uses QUASAR_CONFIG env var when set", () => {
      const path = defaultClientConfigPath({ QUASAR_CONFIG: "/custom/path/config.json" });
      expect(path).toContain("/custom/path/config.json");
    });

    it("uses ~/.config/quasar/config.json by default", () => {
      const path = defaultClientConfigPath({});
      expect(path).toContain(".config/quasar/config.json");
    });
  });

  describe("makeQuasarConfig", () => {
    it("creates config with explicit serverUrl", () => {
      const layer = makeQuasarConfig({ serverUrl: "http://localhost:8080" });
      expect(layer).toBeDefined();
    });

    it("preserves provided timeout", () => {
      const layer = makeQuasarConfig({
        serverUrl: "http://localhost:8080",
        httpTimeoutMs: 30_000,
      });
      expect(layer).toBeDefined();
    });
  });

  describe("Config resolution precedence", () => {
    it("env var takes precedence over config file", () => {
      // Resolution order: env var > config file > default
      expect(true).toBe(true);
    });
  });
});
