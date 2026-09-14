# One image for api, bot and worker; the service decides which entrypoint runs.
# Multi-arch: builds on arm64 (Oracle Ampere, Apple Silicon) and amd64 alike.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Bake the package manager in: corepack would otherwise download it on first container start,
# which needs network access and delays every boot.
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/agent/package.json packages/agent/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/discord-ui/package.json packages/discord-ui/
COPY packages/github/package.json packages/github/
COPY packages/llm/package.json packages/llm/
COPY packages/profiles/package.json packages/profiles/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/test-report/package.json packages/test-report/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @dca/dashboard build

FROM base AS runtime
# git: repository checkout and push. docker CLI: the worker creates sandbox containers
# through the host daemon (socket mounted in compose).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app
ENV NODE_ENV=production
# Services run through tsx directly: going via pnpm would make the container fetch the
# package manager binary on every start, which needs network access.
CMD ["node_modules/.bin/tsx", "apps/api/src/main.ts"]
