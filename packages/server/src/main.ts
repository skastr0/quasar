#!/usr/bin/env bun
import { serve } from "./server";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const intArg = (name: string, fallback: number): number => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

serve({
  port: intArg("--port", 6180),
  hostname: arg("--host") ?? process.env.QUASAR_LOCAL_HOST ?? "127.0.0.1",
});
