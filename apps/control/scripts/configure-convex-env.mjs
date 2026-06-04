import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  quasarClientConfigPath,
  quasarConvexLocalRoot,
} from "./quasar-state.mjs";

const localRoot = quasarConvexLocalRoot();
const localConfigPath = resolve(localRoot, "config.json");
const generatedRoot = resolve(".convex", "local", "default");
const generatedConfigPath = resolve(generatedRoot, "config.json");

if (!existsSync(localConfigPath)) {
  console.error(`Missing ${localConfigPath}. Run bun run local:init first.`);
  process.exit(1);
}

if (!existsSync(generatedConfigPath)) {
  mkdirSync(dirname(generatedRoot), { recursive: true, mode: 0o700 });
  cpSync(localRoot, generatedRoot, { recursive: true, force: true });
}

const localConfig = readJson(localConfigPath);
const clientConfigPath = quasarClientConfigPath();
const clientConfig = existsSync(clientConfigPath)
  ? readJson(clientConfigPath)
  : {};

const embeddingKey =
  process.env.GOOGLE_API_KEY?.trim() ||
  process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
  process.env.GEMINI_API_KEY?.trim();
if (embeddingKey === undefined || embeddingKey.length === 0) {
  console.error(
    "Missing GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or GEMINI_API_KEY.",
  );
  process.exit(1);
}

const controlToken =
  process.env.QUASAR_CONTROL_TOKEN?.trim() ||
  (typeof clientConfig.token === "string" ? clientConfig.token.trim() : "") ||
  `qsr_${randomBytes(32).toString("base64url")}`;

for (const [name, value] of [
  ["GOOGLE_API_KEY", embeddingKey],
  ["GEMINI_API_KEY", embeddingKey],
  ["QUASAR_CONTROL_TOKEN", controlToken],
]) {
  setConvexEnv(name, value);
}

writeClientConfig({ ...clientConfig, token: controlToken });

console.log(
  "Configured Quasar Convex environment variables and local CLI token.",
);

function setConvexEnv(name, value) {
  const result = spawnSync("bunx", ["convex", "env", "set", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...process.env,
      CONVEX_DEPLOYMENT:
        typeof localConfig.deploymentName === "string"
          ? localConfig.deploymentName
          : "anonymous-agent",
      CONVEX_AGENT_MODE: "anonymous",
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function writeClientConfig(config) {
  mkdirSync(dirname(clientConfigPath), { recursive: true, mode: 0o700 });
  writeFileSync(clientConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(clientConfigPath, 0o600);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
