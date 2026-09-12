# Sandbox for Python repositories. Runs as uid 1000 with a read-only root filesystem;
# everything writable lives under /workspace (a per-job volume) or /tmp.
FROM ghcr.io/astral-sh/uv:0.8 AS uv

FROM python:3.12-slim-bookworm

COPY --from=uv /uv /uvx /usr/local/bin/
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates build-essential procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 sandbox && useradd -u 1000 -g 1000 -d /workspace/home -s /bin/bash sandbox

RUN mkdir -p /workspace/repo /workspace/home && chown -R 1000:1000 /workspace
USER 1000:1000
WORKDIR /workspace/repo
ENV HOME=/workspace/home CI=true UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
