# Green Terminal — one image: the lset app with its managed internal
# EdgeDepth gateway. The G-Flow WASM surface was retired (native workspace
# widgets now carry DOM/heatmap/tape/footprints), so the gateway is an
# INTERNAL service only: it binds loopback inside the container and is not
# published to the host or the browser. The gateway binary is linux/amd64
# (see bin/edgedepth-gateway) — build/run with --platform=linux/amd64 on
# Apple Silicon / ARM hosts so the binary can execute.

FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # Browser-facing app (published to the host).
    LSE_HOST=0.0.0.0 \
    LSE_PORT=7787 \
    # Internal EdgeDepth gateway: loopback inside the container; the app's
    # /api/edgedepth/status probes it here. Nothing outside connects.
    EDGEDEPTH_PORT=18791 \
    EDGEDEPTH_HOST=127.0.0.1 \
    LSE_TERMINAL_CONFIG_DIR=/tmp/lse-terminal \
    LSE_TERMINAL_REMOTE=1

WORKDIR /app

# System deps for scientific wheels (pyarrow/pandas) on slim images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

# Package metadata first for layer caching.
COPY pyproject.toml README.md ./
COPY lse_terminal ./lse_terminal

# Prebuilt gateway (discovery order: EDGEDEPTH_GATEWAY_BIN → bin/ → …).
COPY bin ./bin
RUN chmod +x /app/bin/edgedepth-gateway

# Vendored gateway sources are optional at runtime (binary is enough) but keep
# the tree so /api/edgedepth status paths and docs stay truthful if rebuilt.
COPY third_party/edgedepth-gateway ./third_party/edgedepth-gateway

RUN pip install -e . \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin gt \
 && mkdir -p /tmp/lse-terminal \
 && chown -R gt:gt /app /tmp/lse-terminal

USER gt

EXPOSE 7787

HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${LSE_PORT}/api/health" || exit 1

# Same entry as render.yaml; host must be 0.0.0.0 inside the container.
CMD ["sh", "-c", "exec lset --host 0.0.0.0 --port ${LSE_PORT} --no-browser"]
