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

# Extra interpreters so `.python-version` / requires-python pins work without downloads at
# job time (the sandbox has no route to python.org or GitHub). 3.12 is the system Python.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv python install 3.10 3.11 3.13 \
 && chmod -R a+rX /opt/uv-python

RUN mkdir -p /workspace/repo /workspace/home && chown -R 1000:1000 /workspace
USER 1000:1000
WORKDIR /workspace/repo
ENV HOME=/workspace/home CI=true UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
