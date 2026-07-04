FROM oven/bun:1.3.14-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN bun install --frozen-lockfile

COPY packages ./packages
COPY scripts ./scripts

# simsimd 6.5.5's linux-arm64 "prebuild" is a mislabeled x86_64 binary
# (rejected by the ELF check in vectorKernel.ts), so the f16 cosine kernel is
# compiled from the pinned package sources at image build time. Without this
# the server silently degrades to the JS fallback kernel and the semantic
# latency gates fail.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/* \
  && bun scripts/ensure-simsimd-native.mjs

ENV NODE_ENV=production \
  QUASAR_LOCAL_HOME=/data/quasar \
  QUASAR_LOCAL_SQLITE=/data/quasar/quasar.sqlite \
  QUASAR_LOCAL_HOST=0.0.0.0 \
  QUASAR_LOCAL_PORT=6180

VOLUME ["/data/quasar"]
EXPOSE 6180

HEALTHCHECK --interval=10s --timeout=10s --start-period=10s --retries=6 \
  CMD curl -fsS http://127.0.0.1:${QUASAR_LOCAL_PORT}/health >/dev/null || exit 1

CMD ["bun", "packages/server/src/main.ts", "--host", "0.0.0.0", "--port", "6180"]
