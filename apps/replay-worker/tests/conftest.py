"""Shared pytest fixtures."""
from __future__ import annotations

# Side-effect import: defuses browser-use's macOS AppKit display detection
# BEFORE any test imports browser_use (e.g. via `mock.patch("browser_use.X")`
# which calls `unittest.mock.get_original` and triggers the import). See
# `app/_browser_use_compat.py` for the full crash-cause writeup.
import app  # noqa: F401  # re-exports the shim via app/__init__.py

import os
from collections.abc import Iterator

import pytest


@pytest.fixture(autouse=True)
def _set_test_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("REPLAY_WORKER_SHARED_SECRET", "test-secret-32-chars-aaaaaaaaaaaa")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-key-for-tests-only")
    monkeypatch.setenv("LOG_LEVEL", "warning")
    # Reset the lru_cache on Settings so the env vars take effect.
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
