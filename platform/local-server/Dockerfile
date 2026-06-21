FROM oven/bun:1.3.14-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/search/package.json packages/search/package.json
COPY packages/local-server/package.json packages/local-server/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN bun install --frozen-lockfile

COPY packages ./packages

ENV NODE_ENV=production \
  QUASAR_LOCAL_HOME=/data/quasar \
  QUASAR_LOCAL_SQLITE=/data/quasar/quasar.sqlite \
  QUASAR_SEARCH_DATA_DIR=/data/quasar/search.lance \
  QUASAR_LOCAL_HOST=0.0.0.0 \
  QUASAR_LOCAL_PORT=6180

VOLUME ["/data/quasar"]
EXPOSE 6180

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD curl -fsS http://127.0.0.1:${QUASAR_LOCAL_PORT}/health >/dev/null || exit 1

CMD ["bun", "packages/cli/src/cli.ts", "serve", "--host", "0.0.0.0", "--port", "6180"]
