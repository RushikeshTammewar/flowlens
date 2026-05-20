"""Phase 4 / Tier 3 — assertion engine handlers.

These tests stub the CDP `Runtime.evaluate` boundary with a fake
`session` that records the JS expression we'd send and returns canned
values. No real browser, no real LLM. The point is to lock in:

  - dispatch table → handler routing
  - pass / fail / fallback polarity per kind
  - DeterministicCheckUnavailable → LLM fallback handoff
  - polarity (passed/not-passed) is RAW (no shouldPass flip — that
    happens at aggregation time in the web layer)
"""
from __future__ import annotations

from typing import Any

import pytest

from app.assertion_engine import DETERMINISTIC_HANDLERS, evaluate
from app.contracts import Assertion, AssertionSpec


class FakeCdpClient:
    def __init__(self, js_value: Any) -> None:
        self._js_value = js_value
        self.last_expression: str | None = None

    class _Send:
        def __init__(self, parent: "FakeCdpClient") -> None:
            self.parent = parent
            self.Runtime = self  # so .Runtime.evaluate works
            self.Page = self  # idle stubs for screenshot etc.

        async def evaluate(self, *, params: dict[str, Any], session_id: str) -> dict[str, Any]:
            self.parent.last_expression = params.get("expression")
            return {"result": {"value": self.parent._js_value}}

    @property
    def send(self) -> "FakeCdpClient._Send":
        return FakeCdpClient._Send(self)


class FakeCdpSession:
    def __init__(self, js_value: Any) -> None:
        self.cdp_client = FakeCdpClient(js_value)
        self.session_id = "fake-session"


class FakeBrowserSession:
    def __init__(self, js_value: Any) -> None:
        self._cdp = FakeCdpSession(js_value)

    async def get_or_create_cdp_session(self, *, target_id: Any = None):
        return self._cdp


def _make_assertion(kind: str, **payload: Any) -> Assertion:
    spec = AssertionSpec(kind=kind, **payload)  # type: ignore[arg-type]
    return Assertion(spec=spec, fallbackPrompt=f"check that {kind} held")


@pytest.mark.asyncio
async def test_url_matches_pass() -> None:
    sess = FakeBrowserSession("https://example.com/courses?lang=Java")
    a = _make_assertion("url_matches", pattern=r"lang=Java")
    out = await evaluate(
        session=sess,
        assertion=a,
        run_id="r1",
    )
    assert out.passed is True
    assert out.evaluatedKind == "url_matches"
    assert out.llmFallbackUsed is False
    assert out.evidence["actualUrl"] == "https://example.com/courses?lang=Java"


@pytest.mark.asyncio
async def test_url_matches_fail() -> None:
    sess = FakeBrowserSession("https://example.com/courses")
    a = _make_assertion("url_matches", pattern=r"lang=Python")
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is False
    assert out.llmFallbackUsed is False


@pytest.mark.asyncio
async def test_dom_text_present_pass() -> None:
    sess = FakeBrowserSession({"found": True, "sampleStart": "...Java courses..."})
    a = _make_assertion("dom_text_present", text="Java")
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is True
    assert out.evaluatedKind == "dom_text_present"


@pytest.mark.asyncio
async def test_dom_text_absent_pass_when_absent() -> None:
    """`dom_text_absent` flips polarity on the same probe."""
    sess = FakeBrowserSession({"found": False})
    a = _make_assertion("dom_text_absent", text="<script>")
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is True


@pytest.mark.asyncio
async def test_dom_count_eq_pass() -> None:
    sess = FakeBrowserSession(17)
    a = _make_assertion("dom_count", selector="table tbody tr", op="eq", n=17)
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is True
    assert out.evidence["actualCount"] == 17


@pytest.mark.asyncio
async def test_dom_count_gte_pass() -> None:
    sess = FakeBrowserSession(20)
    a = _make_assertion("dom_count", selector="li", op="gte", n=10)
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is True


@pytest.mark.asyncio
async def test_row_content_match_full_match() -> None:
    sess = FakeBrowserSession({"total": 5, "matched": 5, "mismatched": []})
    a = _make_assertion(
        "row_content_match",
        rowSelector="table tbody tr",
        columnSelector="td:nth-child(3)",
        expectedValue="Java",
    )
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is True
    assert out.evidence["matched"] == 5
    assert out.evidence["total"] == 5


@pytest.mark.asyncio
async def test_row_content_match_partial_fail() -> None:
    sess = FakeBrowserSession({"total": 5, "matched": 3, "mismatched": ["Python", "C#"]})
    a = _make_assertion(
        "row_content_match",
        rowSelector="table tbody tr",
        columnSelector="td:nth-child(3)",
        expectedValue="Java",
    )
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is False
    assert out.evidence["matched"] == 3


@pytest.mark.asyncio
async def test_page_load_no_crash_passes_for_real_page() -> None:
    sess = FakeBrowserSession({"ok": True, "url": "https://example.com/courses", "htmlLen": 5000})
    a = _make_assertion("page_load_no_crash")
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is True


@pytest.mark.asyncio
async def test_page_load_no_crash_fails_for_blank() -> None:
    sess = FakeBrowserSession({"ok": False, "url": "about:blank", "htmlLen": 50})
    a = _make_assertion("page_load_no_crash")
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.passed is False
    assert out.evidence["isCrashUrl"] is True


@pytest.mark.asyncio
async def test_console_no_errors_falls_to_llm_when_no_injector(monkeypatch: pytest.MonkeyPatch) -> None:
    """`console_no_errors` raises DeterministicCheckUnavailable when no
    injector is on the page; engine MUST fall through to LLM judge."""
    sess = FakeBrowserSession({"hasInjector": False, "errors": []})

    async def fake_judge(**kwargs: Any) -> Any:
        from app.contracts import JudgeVerdict

        return JudgeVerdict(verdict="pass", reason="no visible errors in screenshot", confidence=0.8)

    monkeypatch.setattr("app.assertion_engine.judge_step", fake_judge)
    a = _make_assertion("console_no_errors")
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.llmFallbackUsed is True
    assert out.passed is True
    assert "no visible errors" in out.reason


@pytest.mark.asyncio
async def test_screenshot_judge_always_uses_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    sess = FakeBrowserSession(None)

    async def fake_judge(**kwargs: Any) -> Any:
        from app.contracts import JudgeVerdict

        return JudgeVerdict(verdict="fail", reason="visible 500 page", confidence=0.95)

    monkeypatch.setattr("app.assertion_engine.judge_step", fake_judge)
    a = _make_assertion("screenshot_judge")
    out = await evaluate(session=sess, assertion=a, run_id="r1")
    assert out.llmFallbackUsed is True
    assert out.passed is False
    assert out.evaluatedKind == "screenshot_judge"


def test_handler_table_covers_documented_kinds() -> None:
    """Lock the table — every deterministic kind from LLD §6.4 must
    have a handler."""
    expected = {
        "url_matches",
        "dom_text_present",
        "dom_text_absent",
        "dom_count",
        "row_content_match",
        "console_no_errors",
        "no_network_5xx",
        "page_load_no_crash",
    }
    assert set(DETERMINISTIC_HANDLERS.keys()) == expected
