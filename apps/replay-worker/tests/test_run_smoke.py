"""End-to-end-ish /run smoke with all browser-use + OpenAI calls mocked.

This test exists specifically to lock down the SIGABRT we observed in Phase 3.8:
the sidecar accepted POST /run, returned HTTP 200, then died with exit 134
mid-stream. Running this test confirms whether our Python code paths are clean
when `browser_use.BrowserSession` and `browser_use.Agent` cooperate normally —
i.e. whether the SIGABRT is in our orchestration layer or in browser-use's
live CDP connection.

If this test passes, the SIGABRT is empirically NOT in our code; it must be
coming from browser-use's live CDP/WebSocket layer when handed a real BU Cloud
URL on this host. That's a different fix (subprocess isolation, version pin,
etc.) and the path forward is documented in CHANGELOG.md.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


VALID_BEARER = "test-shared-secret-32-chars-or-more-needed"


class _FakeBrowserSession:
    """In-memory stub for browser_use.BrowserSession.

    The real class spins up an event-bus + watchdog tree that talks to a CDP
    endpoint. None of that is exercised in this test — we only need start/stop
    plus the auth-wall introspection methods to be coroutines that resolve.
    """

    def __init__(self, cdp_url: str = "", keep_alive: bool = False, **_kwargs: Any) -> None:
        self.cdp_url = cdp_url
        self.keep_alive = keep_alive
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def get_current_page_url(self) -> str:
        return "https://example.com/"

    async def evaluate(self, _js: str) -> Any:
        return False  # no password input visible — clean page


def _fake_history(success: bool = True) -> MagicMock:
    """Mimic the AgentHistory API surface our caller probes."""
    mock_entry = MagicMock()
    mock_entry.result = [MagicMock(success=success, error=None)]
    history = MagicMock()
    history.history = [mock_entry]
    history.is_done = MagicMock(return_value=success)
    history.usage = {"prompt_tokens": 1234, "completion_tokens": 56}
    return history


@pytest.fixture(autouse=True)
def _set_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Provide both env vars the worker requires before any handler runs."""
    monkeypatch.setenv("REPLAY_WORKER_SHARED_SECRET", VALID_BEARER)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-stub-key-for-tests-only-32+chars")
    # Force the cached settings to reload so the test sees our env.
    from app.config import get_settings

    get_settings.cache_clear()


def _request_body() -> dict[str, Any]:
    """A 2-step flow: navigate then click. Matches what the live smoke would send."""
    return {
        "runId": "smoke-mock",
        "flow": {
            "id": "smoke-flow",
            "name": "smoke flow",
            "siteOrigin": "https://example.com",
            "steps": [
                {
                    "index": 0,
                    "action": "navigate",
                    "intent": "Open the example.com homepage",
                    "expectedOutcome": "Page loads",
                    "isCritical": False,
                    "selectors": {},
                    "recordedValue": None,
                    "isSensitive": False,
                    "recordedScreenshotKey": "",
                    "url": "https://example.com",
                },
                {
                    "index": 1,
                    "action": "click",
                    "intent": "Click the More information link",
                    "expectedOutcome": "Navigate to iana.org",
                    "isCritical": False,
                    "selectors": {
                        "role": "link",
                        "accessibleName": "More information...",
                        "css": "a",
                        "xpath": "/html/body/div/p[2]/a",
                    },
                    "recordedValue": None,
                    "isSensitive": False,
                    "recordedScreenshotKey": "",
                    "url": None,
                },
            ],
        },
        "cdpUrl": "wss://fake.cdp.invalid/devtools/browser/mock",
        "liveUrl": "https://fake.live.invalid/",
        "mode": {"name": "hybrid"},
        "recordedScreenshotsByIndex": {},
        "sensitiveData": {},
    }


def _parse_sse(text: str) -> list[dict[str, Any]]:
    """Parse a complete SSE stream string into event dicts.

    Format per spec: `event: <name>\\n` (optional) + `data: <json>\\n` then
    blank line. We only care about the `data:` payload.
    """
    events: list[dict[str, Any]] = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        for line in block.split("\n"):
            if line.startswith("data:"):
                payload = line[5:].lstrip()
                if not payload:
                    continue
                try:
                    events.append(json.loads(payload))
                except json.JSONDecodeError:
                    pass  # ping/comment line
    return events


def test_run_emits_step_events_with_mocked_browser_use() -> None:
    """The full /run code path should yield 2 step_started + 2 step_finished
    + 1 run_complete events when browser_use is fully mocked. This confirms
    nothing in our orchestration triggers SIGABRT under normal conditions.
    """
    fake_agent = MagicMock()
    fake_agent.run = AsyncMock(return_value=_fake_history(success=True))
    AgentClass = MagicMock(return_value=fake_agent)

    with (
        # Mock the import inside _replay()
        patch("browser_use.BrowserSession", _FakeBrowserSession),
        # Mock the import inside run_agent_step()
        patch("browser_use.Agent", AgentClass),
        # ChatOpenAI is constructed but not actually called when Agent.run() is mocked.
        patch("browser_use.llm.ChatOpenAI", MagicMock()),
        # CDP-direct path requires a live WebSocket; force the resolver to return
        # "not found" so we exercise the agent-loop branch instead.
        patch(
            "app.run.resolve_backend_node_id",
            AsyncMock(return_value=MagicMock(found=False)),
        ),
    ):
        client = TestClient(app)
        response = client.post(
            "/run",
            json=_request_body(),
            headers={"Authorization": f"Bearer {VALID_BEARER}"},
        )
        assert response.status_code == 200, response.text[:500]
        events = _parse_sse(response.text)

    types = [e.get("type") for e in events]
    assert "step_started" in types, f"no step_started event: {types}; raw={response.text[:500]!r}"
    assert "step_finished" in types, f"no step_finished event: {types}"
    assert "run_complete" in types, f"no run_complete event: {types}"

    finished = [e for e in events if e.get("type") == "step_finished"]
    assert len(finished) == 2, f"expected 2 step_finished, got {len(finished)}: {finished}"

    complete = [e for e in events if e.get("type") == "run_complete"][-1]
    assert complete["status"] == "passed", f"expected passed, got {complete}"
    assert complete["healthScore"] == 100, complete


def test_run_propagates_browser_session_start_failure_cleanly() -> None:
    """If BrowserSession.start() raises, the handler must NOT crash uvicorn
    with SIGABRT. It should surface a clean error instead.

    This test directly probes the regression scenario: live BU CDP can blow
    up inside `start()` with a native abort. We can't reproduce that natively
    in pytest, but we can prove our handler propagates Python-level exceptions
    cleanly so any future native crash gets caught by `try/except` rather
    than tearing down the process.
    """

    class _FailingSession(_FakeBrowserSession):
        async def start(self) -> None:  # type: ignore[override]
            raise RuntimeError("simulated CDP handshake failure")

    with (
        patch("browser_use.BrowserSession", _FailingSession),
        patch("browser_use.Agent", MagicMock()),
        patch("browser_use.llm.ChatOpenAI", MagicMock()),
        patch(
            "app.run.resolve_backend_node_id",
            AsyncMock(return_value=MagicMock(found=False)),
        ),
    ):
        client = TestClient(app)
        # Without our defensive wrapper this would hang the SSE stream and
        # eventually crash uvicorn; with the wrapper we expect either a clean
        # 500 OR a clean run_complete(status=errored) event.
        response = client.post(
            "/run",
            json=_request_body(),
            headers={"Authorization": f"Bearer {VALID_BEARER}"},
        )
        # Either a 500 (uvicorn surfacing the exception cleanly) or
        # a 200 with run_complete(errored) is acceptable.
        if response.status_code == 200:
            events = _parse_sse(response.text)
            completes = [e for e in events if e.get("type") == "run_complete"]
            assert completes, f"start() failed but no run_complete event: {events}"
            assert completes[-1]["status"] == "errored", completes
        else:
            assert response.status_code == 500, response.status_code
