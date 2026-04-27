"""/healthz route smoke test."""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_healthz_returns_200() -> None:
    from app.main import app  # imported lazily so configure_logging runs once

    client = TestClient(app)
    res = client.get("/healthz")
    assert res.status_code == 200
    body = res.json()
    assert "version" in body
    assert "browserUseAvailable" in body
    assert "openaiAvailable" in body
