# syntax=docker/dockerfile:1.7
# Multi-stage build for the Flowlens Python replay worker.
# Designed to boot in <10s on AWS App Runner / Azure Container Apps cold start.

FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ─── builder ──────────────────────────────────────────────
FROM base AS builder
WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY app ./app

# Resolve and install into an isolated prefix we'll copy into the runtime stage.
RUN pip install --upgrade pip wheel \
    && pip install --prefix=/install .

# ─── runtime ──────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

# Non-root user (App Runner / Container Apps both prefer this).
RUN useradd --create-home --uid 10001 flowlens
COPY --from=builder /install /usr/local
COPY --from=builder /build/app ./app

USER flowlens
EXPOSE 8000

# App Runner + Container Apps both health-check via HTTP; both will scrape /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status==200 else 1)"

# Single uvicorn worker; horizontal scaling is the platform's job.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
