import { Context, Effect, Layer } from "effect";

import { quasarLocalHome, sqlitePath } from "./paths";

export interface ServerConfig {
  readonly hostname: string;
  readonly port: number;
}

export interface LocalServerConfigService {
  readonly home: string;
  readonly sqlitePath: string;
  readonly server: ServerConfig;
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export class LocalServerConfig extends Context.Tag("@quasar/LocalServerConfig")<
  LocalServerConfig,
  LocalServerConfigService
>() {}

export const LocalServerConfigLive = Layer.effect(
  LocalServerConfig,
  Effect.sync(() =>
    LocalServerConfig.of({
      home: quasarLocalHome(),
      sqlitePath: sqlitePath(),
      server: {
        hostname: process.env.QUASAR_LOCAL_HOST?.trim() || "127.0.0.1",
        port: envInt("QUASAR_LOCAL_PORT", 6180),
      },
    }),
  ),
);
