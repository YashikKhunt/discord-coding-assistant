# Sandbox for Node.js repositories. Runs as uid 1000 with a read-only root filesystem;
# everything writable lives under /workspace (a per-job volume) or /tmp.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates python3 make g++ procps \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

RUN mkdir -p /workspace/repo /workspace/home && chown -R 1000:1000 /workspace
USER 1000:1000
WORKDIR /workspace/repo
ENV HOME=/workspace/home CI=true
