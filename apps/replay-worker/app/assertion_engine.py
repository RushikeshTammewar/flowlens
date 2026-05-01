"""Phase 4 / Tier 3 — variant-level assertion engine.

After every variant's step loop terminates (success OR failure), this
engine evaluates the variant's `assertion`. Deterministic-first:

  - DETERMINISTIC_HANDLERS dispatches by `assertion.spec.kind` to a
    raw-CDP query (Runtime.evaluate against the live page) that returns
    a boolean + evidence dict. ~50 ms per check, no LLM cost.
  - If no deterministic handler matches OR the handler raises
    `DeterministicCheckUnavailable` (e.g. selector unresolved on a
    page that didn't render), we fall through to the vision LLM judge
    using the assertion's `fallbackPrompt` as the English claim.

Polarity (variant.shouldPass) is INTENTIONALLY not applied here. The
engine reports the raw assertion outcome — "did the asserted thing
happen?". The web aggregator (`aggregate-batch-verdict.ts`) flips
polarity for adversarial-mode variants where success means rejection.
Single source of truth for polarity prevents drift between layers.

LLD §6.4 — full algorithm + handler list.
Logged under scope: [phase4:assertion]
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from .contracts import Assertion, AssertionEval, AssertionKind
from .judge import judge_step
from .telemetry import log


class DeterministicCheckUnavailable(RuntimeError):
    """Raised by a deterministic handler when it cannot make a confident
    determination — e.g. a selector returned nothing AND the spec didn't
    say "absent". Caller falls through to the LLM judge."""


HandlerResult = tuple[bool, dict[str, Any]]
Handler = Callable[..., Awaitable[HandlerResult]]


async def evaluate(
    *,
    session: Any,
    assertion: Assertion,
    run_id: str,
    fallback_recorded_screenshot_url: str | None = None,
    fallback_replay_screenshot_url: str | None = None,
    last_step_action_summary: str = "(no action summary)",
) -> AssertionEval:
    """Run `assertion` against the live page and return an AssertionEval.

    Always returns — never raises. Internal exceptions become a
    deterministic FAIL with the exception text in `reason` so the
    caller can persist + report a clean record.
    """
    started = time.monotonic()
    spec = assertion.spec
    kind: AssertionKind = spec.kind

    log.info("[phase4:assertion]", runId=run_id, kind=kind, evaluating=True)

    # Some assertion kinds are intrinsically LLM (screenshot_judge) — go
    # straight to fallback without trying a deterministic handler.
    if kind == "screenshot_judge":
        return await _llm_judge_fallback(
            assertion=assertion,
            run_id=run_id,
            fallback_recorded_screenshot_url=fallback_recorded_screenshot_url,
            fallback_replay_screenshot_url=fallback_replay_screenshot_url,
            last_step_action_summary=last_step_action_summary,
            started=started,
            reason_prefix="screenshot_judge requested",
        )

    handler = DETERMINISTIC_HANDLERS.get(kind)
    if handler is None:
        log.warning(
            "[phase4:assertion]",
            runId=run_id,
            kind=kind,
            note="no deterministic handler registered; falling through to LLM judge",
        )
        return await _llm_judge_fallback(
            assertion=assertion,
            run_id=run_id,
            fallback_recorded_screenshot_url=fallback_recorded_screenshot_url,
            fallback_replay_screenshot_url=fallback_replay_screenshot_url,
            last_step_action_summary=last_step_action_summary,
            started=started,
            reason_prefix=f"no handler for {kind}",
        )

    try:
        passed, evidence = await handler(session, _spec_payload(spec))
    except DeterministicCheckUnavailable as e:
        log.info(
            "[phase4:assertion]",
            runId=run_id,
            kind=kind,
            note=f"deterministic check unavailable, falling through to LLM judge: {e}",
        )
        return await _llm_judge_fallback(
            assertion=assertion,
            run_id=run_id,
            fallback_recorded_screenshot_url=fallback_recorded_screenshot_url,
            fallback_replay_screenshot_url=fallback_replay_screenshot_url,
            last_step_action_summary=last_step_action_summary,
            started=started,
            reason_prefix=f"deterministic-unavailable: {e}",
        )
    except Exception as e:
        # Hard failure inside the handler (CDP error, JS exception we
        # didn't classify). Don't lose the run — emit a FAIL with the
        # exception text so the report shows it. Most often this means
        # the page never loaded and we'll see "JS exception" / similar.
        log.warning(
            "[phase4:assertion]",
            runId=run_id,
            kind=kind,
            error=str(e)[:200],
        )
        return AssertionEval(
            passed=False,
            evaluatedKind=kind,
            reason=f"assertion handler raised: {str(e)[:200]}",
            evidence={"exception": str(e)[:500]},
            evaluatedAt=_now_iso(),
            durationMs=int((time.monotonic() - started) * 1000),
            llmFallbackUsed=False,
        )

    eval_obj = AssertionEval(
        passed=passed,
        evaluatedKind=kind,
        reason=_describe_outcome(kind, passed, evidence),
        evidence=evidence,
        evaluatedAt=_now_iso(),
        durationMs=int((time.monotonic() - started) * 1000),
        llmFallbackUsed=False,
    )
    log.info(
        "[phase4:assertion]",
        runId=run_id,
        kind=kind,
        passed=passed,
        durationMs=eval_obj.durationMs,
    )
    return eval_obj


def _spec_payload(spec: Any) -> dict[str, Any]:
    """Pull the spec payload as a plain dict regardless of whether the
    Pydantic model carried extra fields (extra='allow' on AssertionSpec)
    or strict typed fields. The handlers index by string keys so they
    don't care about model discipline."""
    if hasattr(spec, "model_dump"):
        return spec.model_dump()  # type: ignore[no-any-return]
    if isinstance(spec, dict):
        return spec
    return {"kind": getattr(spec, "kind", "unknown")}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _describe_outcome(kind: str, passed: bool, evidence: dict[str, Any]) -> str:
    """Produce a short human-readable reason for the report. Mirrors the
    spec-specific evidence keys."""
    if not passed:
        # Common failure shapes — give the report a useful hint.
        if "matched" in evidence:
            return f"{kind}: matched {evidence['matched']} of {evidence.get('total', '?')}"
        if "actualUrl" in evidence:
            return f"{kind}: url={evidence['actualUrl']!r}"
        if "actualCount" in evidence:
            return f"{kind}: count={evidence['actualCount']} expected {evidence.get('op', '?')} {evidence.get('n', '?')}"
        if "errorSample" in evidence:
            return f"{kind}: {evidence['errorSample']}"
        return f"{kind} did not hold"
    return f"{kind} held"


# ──────────────────────── deterministic handlers ───────────────────────────


async def _runtime_evaluate(session: Any, expression: str) -> Any:
    """Run a JS expression on the active CDP target. Mirrors the helper
    in simple_replay._evaluate but kept private so this module is
    importable without dragging in simple_replay's typing.
    """
    cdp_session = await session.get_or_create_cdp_session(target_id=None)
    res = await cdp_session.cdp_client.send.Runtime.evaluate(
        params={
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        },
        session_id=cdp_session.session_id,
    )
    if "exceptionDetails" in res:
        raise DeterministicCheckUnavailable(
            f"JS exception: {res['exceptionDetails'].get('text', 'unknown')}"
        )
    return (res.get("result") or {}).get("value")


async def _check_url_matches(session: Any, payload: dict[str, Any]) -> HandlerResult:
    pattern = payload.get("pattern")
    if not pattern:
        raise DeterministicCheckUnavailable("url_matches requires `pattern`")
    actual = await _runtime_evaluate(session, "location.href")
    actual_str = str(actual) if actual is not None else ""
    try:
        rx = re.compile(pattern)
    except re.error as e:
        raise DeterministicCheckUnavailable(f"invalid pattern: {e}")
    matched = rx.search(actual_str) is not None
    return matched, {"pattern": pattern, "actualUrl": actual_str}


async def _check_dom_text_present(session: Any, payload: dict[str, Any]) -> HandlerResult:
    text = payload.get("text")
    within = payload.get("within")
    if not text:
        raise DeterministicCheckUnavailable("dom_text_present requires `text`")
    js = _build_dom_text_js(text=str(text), within=within if isinstance(within, str) and within else None)
    res = await _runtime_evaluate(session, js)
    if not isinstance(res, dict):
        raise DeterministicCheckUnavailable("dom_text_present check returned non-dict")
    found = bool(res.get("found"))
    return found, res


async def _check_dom_text_absent(session: Any, payload: dict[str, Any]) -> HandlerResult:
    # Same probe as dom_text_present, inverted polarity.
    text = payload.get("text")
    within = payload.get("within")
    if not text:
        raise DeterministicCheckUnavailable("dom_text_absent requires `text`")
    js = _build_dom_text_js(text=str(text), within=within if isinstance(within, str) and within else None)
    res = await _runtime_evaluate(session, js)
    if not isinstance(res, dict):
        raise DeterministicCheckUnavailable("dom_text_absent check returned non-dict")
    absent = not bool(res.get("found"))
    return absent, res


def _build_dom_text_js(*, text: str, within: str | None) -> str:
    """Build a JS expression that returns {found: bool, sample: str}.
    Searches visible textContent under `within` (or `document.body` when
    null). Case-insensitive substring match — matches the senior-QA
    intuition of "is this text on the page".
    """
    needle_json = json.dumps(text)
    if within:
        scope_js = f"document.querySelector({json.dumps(within)})"
    else:
        scope_js = "document.body"
    return (
        "(() => {"
        f"  const scope = {scope_js};"
        "  if (!scope) return { found: false, reason: 'scope-not-found' };"
        f"  const needle = ({needle_json}).toLowerCase();"
        "  const text = (scope.innerText || scope.textContent || '').toLowerCase();"
        "  const idx = text.indexOf(needle);"
        "  return { found: idx !== -1, sampleStart: text.slice(Math.max(0, idx-30), idx+60) };"
        "})()"
    )


async def _check_dom_count(session: Any, payload: dict[str, Any]) -> HandlerResult:
    selector = payload.get("selector")
    op = payload.get("op")
    n = payload.get("n")
    if not selector or op not in ("eq", "gte", "lte") or not isinstance(n, (int, float)):
        raise DeterministicCheckUnavailable("dom_count requires {selector, op, n}")
    js = (
        "(() => {"
        f"  const els = document.querySelectorAll({json.dumps(str(selector))});"
        "  return els.length;"
        "})()"
    )
    actual = await _runtime_evaluate(session, js)
    if not isinstance(actual, int):
        raise DeterministicCheckUnavailable(f"dom_count: expected int, got {type(actual).__name__}")
    n_int = int(n)
    if op == "eq":
        passed = actual == n_int
    elif op == "gte":
        passed = actual >= n_int
    else:  # lte
        passed = actual <= n_int
    return passed, {"selector": selector, "actualCount": actual, "op": op, "n": n_int}


async def _check_row_content_match(session: Any, payload: dict[str, Any]) -> HandlerResult:
    """Spec: { selector | rowSelector, columnIndex?, columnSelector?, expectedValue }.

    Accepts both the LLD-canonical key names (`rowSelector` / `columnSelector`)
    and the looser `selector` / `expectedValue` shape that matrix-gen
    occasionally emits — neither is wrong, both surface the same thing.
    """
    row_selector = payload.get("rowSelector") or payload.get("selector")
    if not row_selector:
        raise DeterministicCheckUnavailable("row_content_match requires `rowSelector`")
    column_selector = payload.get("columnSelector")
    column_index = payload.get("columnIndex")
    expected = payload.get("expectedValue") or payload.get("expectedSubstring")
    if expected is None:
        raise DeterministicCheckUnavailable("row_content_match requires `expectedValue`")

    if column_selector:
        cell_js = f"row.querySelector({json.dumps(str(column_selector))})"
    elif isinstance(column_index, int):
        cell_js = f"row.children[{int(column_index)}]"
    else:
        cell_js = "row"  # whole row text

    js = (
        "(() => {"
        f"  const rows = document.querySelectorAll({json.dumps(str(row_selector))});"
        "  const out = { total: rows.length, matched: 0, mismatched: [] };"
        "  for (const row of rows) {"
        f"    const cell = {cell_js};"
        "    const text = ((cell && (cell.textContent || cell.innerText)) || '').trim();"
        f"    if (text.toLowerCase().includes(({json.dumps(str(expected))}).toLowerCase())) out.matched++;"
        "    else if (out.mismatched.length < 5) out.mismatched.push(text.slice(0, 80));"
        "  }"
        "  return out;"
        "})()"
    )
    res = await _runtime_evaluate(session, js)
    if not isinstance(res, dict):
        raise DeterministicCheckUnavailable("row_content_match returned non-dict")
    total = int(res.get("total", 0))
    matched = int(res.get("matched", 0))
    if total == 0:
        # Zero rows is ambiguous — could be "filter narrowed to nothing
        # legitimately" or "selector missed". Defer to LLM rather than
        # hand back a confident pass/fail.
        raise DeterministicCheckUnavailable(f"row_content_match: 0 rows matched selector {row_selector!r}")
    passed = matched == total
    return passed, {
        "rowSelector": row_selector,
        "matched": matched,
        "total": total,
        "mismatched": res.get("mismatched", []),
    }


async def _check_console_no_errors(session: Any, _payload: dict[str, Any]) -> HandlerResult:
    """Best-effort console probe via Runtime.evaluate.

    Browser-use's BrowserSession doesn't expose a structured console-
    log buffer through CDP that we can `Get`. We poke for the
    Sentry/window.errors heuristic that most apps stash on uncaught.
    When the heuristic is inconclusive we raise so the LLM judge can
    look at the screenshot for visible error banners instead.
    """
    js = (
        "(() => {"
        "  if (typeof window.__flowlensConsoleErrors !== 'undefined') {"
        "    return { hasInjector: true, errors: window.__flowlensConsoleErrors.slice(0, 10) };"
        "  }"
        "  if (window.onerror && window.__lastError) {"
        "    return { hasInjector: false, errors: [String(window.__lastError)] };"
        "  }"
        "  return { hasInjector: false, errors: [] };"
        "})()"
    )
    res = await _runtime_evaluate(session, js)
    if not isinstance(res, dict):
        raise DeterministicCheckUnavailable("console probe returned non-dict")
    if not res.get("hasInjector"):
        # Nothing definitive — let the LLM look for visible error banners.
        raise DeterministicCheckUnavailable("no console-error injector on page")
    errors = res.get("errors") or []
    if not isinstance(errors, list):
        raise DeterministicCheckUnavailable("console errors not a list")
    return len(errors) == 0, {"errors": errors[:5], "errorSample": (errors[0] if errors else None)}


async def _check_no_network_5xx(_session: Any, _payload: dict[str, Any]) -> HandlerResult:
    """Network 5xx probe is currently a sidecar TODO — we don't capture
    the network event log under simple_replay (would need
    Network.enable + responseReceived listener pre-step). Mark as
    deterministic-unavailable so the LLM looks for a 5xx error page.

    Wired to a real check in Tier 5 alongside Service Worker capture.
    """
    raise DeterministicCheckUnavailable("network log capture not yet wired")


async def _check_page_load_no_crash(session: Any, _payload: dict[str, Any]) -> HandlerResult:
    """The page is alive iff we can read document.documentElement.outerHTML
    length AND the URL isn't a chrome-error://."""
    js = (
        "(() => {"
        "  const ok = document.documentElement && document.documentElement.outerHTML.length > 200;"
        "  return { ok, url: location.href, htmlLen: document.documentElement && document.documentElement.outerHTML.length };"
        "})()"
    )
    res = await _runtime_evaluate(session, js)
    if not isinstance(res, dict):
        raise DeterministicCheckUnavailable("page_load_no_crash returned non-dict")
    url = str(res.get("url") or "")
    is_crash_url = url.startswith("chrome-error://") or url.startswith("about:blank")
    passed = bool(res.get("ok")) and not is_crash_url
    return passed, {
        "actualUrl": url,
        "htmlLen": res.get("htmlLen"),
        "isCrashUrl": is_crash_url,
    }


DETERMINISTIC_HANDLERS: dict[AssertionKind, Handler] = {
    "url_matches": _check_url_matches,
    "dom_text_present": _check_dom_text_present,
    "dom_text_absent": _check_dom_text_absent,
    "dom_count": _check_dom_count,
    "row_content_match": _check_row_content_match,
    "console_no_errors": _check_console_no_errors,
    "no_network_5xx": _check_no_network_5xx,
    "page_load_no_crash": _check_page_load_no_crash,
    # 'screenshot_judge' intentionally absent — always LLM (handled at top).
}


# ──────────────────────── LLM judge fallback ───────────────────────────────


async def _llm_judge_fallback(
    *,
    assertion: Assertion,
    run_id: str,
    fallback_recorded_screenshot_url: str | None,
    fallback_replay_screenshot_url: str | None,
    last_step_action_summary: str,
    started: float,
    reason_prefix: str,
) -> AssertionEval:
    """Wrap the existing per-step `judge_step` (vision LLM) so it can
    answer the variant-level assertion. We feed it the assertion's
    `fallbackPrompt` as the expected outcome and let it return a
    pass/fail verdict + reason from the screenshot pair.

    When no replay screenshot URL is available (e.g. the upload hasn't
    completed when the engine runs) the LLM judge falls back to text-
    only reasoning, which is weaker but still better than nothing.
    """
    try:
        verdict = await judge_step(
            run_id=run_id,
            step_index=-1,  # variant-level, not a real step index
            expected_outcome=assertion.fallbackPrompt,
            action_summary=last_step_action_summary,
            recorded_screenshot_url=fallback_recorded_screenshot_url,
            replay_screenshot_url=fallback_replay_screenshot_url,
        )
        passed = verdict.verdict == "pass"
        reason = f"{reason_prefix} → llm: {verdict.reason}"
        evidence = {
            "llmConfidence": verdict.confidence,
            "fallbackPrompt": assertion.fallbackPrompt,
        }
    except Exception as e:
        log.warning("[phase4:assertion]", runId=run_id, llmFailed=True, error=str(e)[:200])
        passed = False
        reason = f"{reason_prefix}; llm judge errored: {str(e)[:120]}"
        evidence = {"fallbackPrompt": assertion.fallbackPrompt}

    return AssertionEval(
        passed=passed,
        evaluatedKind=assertion.spec.kind,
        reason=reason,
        evidence=evidence,
        evaluatedAt=_now_iso(),
        durationMs=int((time.monotonic() - started) * 1000),
        llmFallbackUsed=True,
    )
