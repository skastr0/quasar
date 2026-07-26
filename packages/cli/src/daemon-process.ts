export const daemonIngestProcess = (
  serverUrl: string,
  ingestToken: string,
  environment: NodeJS.ProcessEnv = process.env,
) => ({
  args: ["ingest", "--provider", "all", "--summary", "--server", serverUrl],
  env: {
    ...environment,
    QUASAR_INGEST_TOKEN: ingestToken,
  },
});
