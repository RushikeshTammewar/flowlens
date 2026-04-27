"""GET /healthz — liveness probe used by AWS App Runner / Azure Container Apps."""
from __future__ import annotations

import importlib

from fastapi import APIRouter

from . import __version__
from .config import get_settings
from .contracts import HealthResponse


router = APIRouter()


@router.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    settings = get_settings()
    browser_use_available = _module_importable("browser_use")
    openai_available = bool(settings.openai_api_key) and _module_importable("openai")
    return HealthResponse(
        ok=browser_use_available and openai_available,
        version=__version__,
        browserUseAvailable=browser_use_available,
        openaiAvailable=openai_available,
    )


def _module_importable(name: str) -> bool:
    try:
        importlib.import_module(name)
        return True
    except Exception:
        return False
