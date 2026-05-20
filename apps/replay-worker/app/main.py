"""FastAPI entrypoint for the Flowlens v3 replay worker.

Run locally:
    uvicorn app.main:app --reload --port 8000

Deploy via Docker:
    docker build -t flowlens-replay-worker .
    docker run -p 8000:8000 \\
        -e OPENAI_API_KEY=$OPENAI_API_KEY \\
        -e REPLAY_WORKER_SHARED_SECRET=$REPLAY_WORKER_SHARED_SECRET \\
        flowlens-replay-worker
"""
from __future__ import annotations

from fastapi import FastAPI

from . import __version__
from .config import get_settings
from .health import router as health_router
from .resolve_route import router as resolve_router
from .run import router as run_router
from .telemetry import configure_logging, log


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    app = FastAPI(
        title="Flowlens replay worker",
        version=__version__,
        description="Wraps browser-use Agent + tools.act() over BU Cloud CDP for the Flowlens TS web app.",
    )
    app.include_router(health_router)
    app.include_router(run_router)
    app.include_router(resolve_router)

    log.info(
        "worker_booted",
        version=__version__,
        replayAgent=settings.flowlens_model_replay_agent,
        judge=settings.flowlens_model_judge,
        hasOpenaiKey=bool(settings.openai_api_key),
        hasSharedSecret=bool(settings.replay_worker_shared_secret),
    )
    return app


app = create_app()
