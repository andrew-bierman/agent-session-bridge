# Hermetic test run: bun canary (lint/fmt/check are canary-only) + sqlite3 CLI.
# Usage (docker or podman): docker build -t localhost/agent-session-bridge-test . && docker run --rm localhost/agent-session-bridge-test
FROM docker.io/oven/bun:canary
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
COPY . .
CMD ["sh", "-c", "bun lint --no-script && bun fmt --check && bun check . && bun run build && bun test"]
