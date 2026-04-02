FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN bun build src/index.ts --outdir dist --target node --format esm

FROM node:24-alpine
RUN apk add --no-cache git openssh-client bash
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Default config location
VOLUME ["/config", "/workspace", "/env-files"]

ENV WORKSPACE=/workspace \
    SYNC_INTERVAL=120 \
    HEALTH_PORT=8080 \
    LOG_LEVEL=info \
    SSH_STRICT_HOST_CHECKING=false

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
