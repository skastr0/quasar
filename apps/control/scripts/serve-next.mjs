import { spawn } from "node:child_process";

const port = process.env.QUASAR_WEB_PORT ?? "5177";
const host = process.env.QUASAR_WEB_HOST ?? "127.0.0.1";
const child = spawn("bunx", ["next", "start", "--port", port, "--hostname", host], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
