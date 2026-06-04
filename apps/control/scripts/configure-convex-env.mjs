import { spawnSync } from "node:child_process";

const key =
  process.env.GOOGLE_API_KEY ??
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
  process.env.GEMINI_API_KEY;

if (key === undefined || key.trim().length === 0) {
  console.error("Missing GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or GEMINI_API_KEY.");
  process.exit(1);
}

for (const [name, value] of [
  ["GOOGLE_API_KEY", key],
  ["GEMINI_API_KEY", key],
]) {
  const result = spawnSync("bunx", ["convex", "env", "set", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Configured Convex embedding environment variables.");
