"""POST /run — stream step-by-step replay events as SSE.

Implements the LLD §6 hybrid algorithm:

```
for each step:
  resolve(selectors) -> backend_node_id?
  if found AND not critical AND mode != full_llm:
    cdp_direct(node_id, step.action, value)            ← no LLM
  else:
    agent_step(flow, step, recorded_prior)             ← Agent loop
  T1 deterministic checks (HTTP / console / JS)
  if step.is_critical:
    T3 judge (gpt-4.1-mini, structured)
  detect_auth_wall? -> emit run_paused, halt
emit run_complete
```

Streaming protocol: standard SSE, one event per JSON object.
Event types: step_started | step_finished | run_paused | run_complete.
"""
from __future__ import annotations

import asyncio
import json
import time
from os import environ as os_environ
from typing import Any, AsyncIterator

os_environ_get = os_environ.get

from fastapi import APIRouter, Depends, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from .agent_step import run_agent_step
from .auth_wall import detect_auth_wall
from .cdp_direct import CdpDirectError, execute_cdp_direct
from .config import get_settings
from .contracts import (
    Flow,
    FlowStep,
    JudgeVerdict,
    RunCompleteEvent,
    RunPausedEvent,
    RunRequest,
    StepFinishedEvent,
    StepResult,
    StepStartedEvent,
)
from .cookie_inject import inject_cookies, navigate_with_cookies
from .judge import judge_step
from .resolve import resolve_backend_node_id
from .security import require_bearer
from .simple_replay import (
    SimpleReplayError,
    capture_screenshot,
    execute_simple,
    quick_auth_probe,
)
from .telemetry import estimate_cost_usd_micro, log


router = APIRouter()


@router.post("/run", dependencies=[Depends(require_bearer)])
async def post_run(req: RunRequest, request: Request) -> EventSourceResponse:
    settings = get_settings()
    if not settings.openai_api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")

    async def stream() -> AsyncIterator[dict[str, str]]:
        async for event in _replay(req, request):
            yield {"event": event.__class__.__name__, "data": event.model_dump_json()}

    return EventSourceResponse(stream(), ping=15)


@router.post("/run-sync", dependencies=[Depends(require_bearer)])
async def post_run_sync(req: RunRequest, request: Request) -> dict[str, Any]:
    """Synchronous wrapper around the same `_replay` pipeline.

    Buffers every event the generator yields and returns them as a single
    JSON envelope when the run terminates. Trades streaming progress for
    transport simplicity — the caller gets ALL step results plus the
    terminal event in one request/response, which avoids the SSE delivery
    pitfalls we hit with Node fetch chunk buffering during a 5-parallel
    matrix run.

    The TS run-batch-inline driver prefers this endpoint; the streaming
    `/run` is kept for the live extension panel which polls SSE for
    in-progress visualization (`live_url` etc. still work because BU
    Cloud's CDP URL is independent of our own event channel).
    """
    settings = get_settings()
    if not settings.openai_api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")

    events: list[dict[str, Any]] = []
    async for event in _replay(req, request):
        events.append({
            "type": event.__class__.__name__,
            "payload": event.model_dump(),
        })
    return {"runId": req.runId, "events": events}


async def _replay(req: RunRequest, request: Request) -> AsyncIterator[Any]:
    """Drives the replay loop and yields contract events.

    Defensive contract: this generator MUST always emit a terminal
    `RunCompleteEvent` (or `RunPausedEvent`) before exiting, even when
    something explodes inside browser-use. The TS-side caller blocks on the
    SSE stream and a torn-down connection looks identical to a hung run; an
    explicit `errored` event lets the workflow fail fast with a clean cause.
    """
    from browser_use import BrowserSession  # type: ignore[import-not-found]

    log.info(
        "[FLOWLENS:run_started]",
        runId=req.runId,
        flowId=req.flow.id,
        flowName=req.flow.name,
        siteOrigin=req.flow.siteOrigin,
        steps=len(req.flow.steps),
        cookieCount=len(req.cookies),
        cdpUrlPrefix=req.cdpUrl[:60],
    )

    healthy = True
    overall_status: str = "passed"
    error_class: str | None = None
    error_summary: str | None = None
    completed_step_results: list[StepResult] = []
    session: Any = None

    paused = False  # set True when we yield a RunPausedEvent (no run_complete after)
    session_started = False
    try:
        # Step A: connect to the CDP. This is the most failure-prone moment —
        # browser-use does the WebSocket handshake here and any network blip,
        # auth issue, or native crash in the underlying CDP client surfaces
        # as a Python exception. We catch it and surface a clean errored
        # run_complete instead of letting the SSE stream tear down.
        session = BrowserSession(cdp_url=req.cdpUrl, keep_alive=True)
        # BU Cloud returns the CDP URL the moment the session row is created,
        # but the underlying Chromium needs ~3-8s to actually bind the
        # websocket. Connecting too early surfaces as "All connection
        # attempts failed". Retry 4x with exponential backoff so the warmup
        # window doesn't kill our run.
        attach_delays = [0, 4, 6, 8]
        last_err: Exception | None = None
        for attempt, delay in enumerate(attach_delays):
            if delay:
                await asyncio.sleep(delay)
            try:
                await session.start()
                session_started = True
                log.info(
                    "[FLOWLENS:bu_session_attached]",
                    runId=req.runId,
                    attempt=attempt + 1,
                )
                break
            except Exception as e:
                last_err = e
                log.warning(
                    "[FLOWLENS:bu_session_attach_retry]",
                    runId=req.runId,
                    attempt=attempt + 1,
                    error=str(e)[:200],
                )
        if not session_started:
            log.error(
                "[FLOWLENS:session_start_failed]",
                runId=req.runId,
                error=str(last_err)[:300] if last_err else "unknown",
            )
            overall_status = "errored"
            error_class = "env"
            error_summary = f"failed to connect to CDP: {last_err}"
            session = None  # don't try to stop a session that never started

        if not session_started:
            # Skip the per-step loop; fall through to the run_complete yield.
            pass
        else:
            # Step B: inject cookies BEFORE the first navigation, then
            # navigate to landingUrl regardless of whether cookies were
            # passed. The navigation is REQUIRED — without it the BU
            # Cloud session stays on about:blank and step 0 will fail
            # with "selector did not resolve" because no element on the
            # recorded page exists yet. (Matrix flows against logged-in
            # sites worked because they always had cookies, which kept
            # the bug hidden — single-flow runs against public sites
            # like practicetestautomation.com surfaced it.)
            if req.cookies:
                inject_report = await inject_cookies(session, req.cookies)
                log.info(
                    "[FLOWLENS:cookies_injected]",
                    runId=req.runId,
                    requested=inject_report["count"],
                    injected=inject_report["injected"],
                    errors=len(inject_report["errors"]),
                )
            else:
                log.info(
                    "[FLOWLENS:cookies_injected]",
                    runId=req.runId,
                    requested=0,
                    injected=0,
                    errors=0,
                    note="no cookies in request; skipping injection",
                )

            landing = req.landingUrl or req.flow.siteOrigin
            nav_report = await navigate_with_cookies(session, landing)
            log.info(
                "[FLOWLENS:landing_after_cookies]",
                runId=req.runId,
                requestedUrl=nav_report["requestedUrl"],
                finalUrl=nav_report["finalUrl"],
                success=nav_report["success"],
            )
            if not nav_report["success"]:
                log.error(
                    "[FLOWLENS:landing_failed]",
                    runId=req.runId,
                    error=nav_report.get("error"),
                )

            async for ev in _drive_steps(req, request, session, completed_step_results):
                yield ev
                if isinstance(ev, RunPausedEvent):
                    paused = True
                    overall_status = "errored"
                    error_class = "auth"
                    healthy = False
                    break
    except Exception as e:
        # Belt-and-suspenders: anything else that escapes (e.g. a bug in our
        # own orchestration) becomes a clean errored event.
        log.error("replay_unexpected_failure", runId=req.runId, error=str(e))
        overall_status = "errored"
        error_class = error_class or "env"
        error_summary = error_summary or f"replay-worker error: {e}"
    finally:
        if session is not None:
            await _safe_stop(session)

    # Recompute aggregate state in case _drive_steps set healthy/overall_status
    # via mutation through the result list rather than a return value.
    if not paused and overall_status == "passed":
        # If any non-critical step failed, mark healthy=False but keep status.
        if any(r.status != "passed" for r in completed_step_results):
            healthy = False
        # If a critical step failed without auth-wall, mark overall failed.
        if any(
            r.status in ("failed", "errored")
            and req.flow.steps[r.stepIndex].isCritical
            for r in completed_step_results
            if r.stepIndex < len(req.flow.steps)
        ):
            overall_status = "failed"
            error_class = error_class or "app_bug"

    if not paused:
        yield RunCompleteEvent(
            runId=req.runId,
            status=overall_status,  # type: ignore[arg-type]
            healthScore=_compute_health_score(completed_step_results, healthy),
            summary=error_summary
            or _compute_summary(req.flow, completed_step_results, overall_status),
            errorClass=error_class,  # type: ignore[arg-type]
        )
    log.info(
        "[FLOWLENS:run_finished]",
        runId=req.runId,
        status=overall_status,
        stepsExecuted=len(completed_step_results),
        stepsFinishedOk=sum(1 for r in completed_step_results if r.status == "passed"),
        totalCostUsdMicro=sum(r.llmCostUsdMicro for r in completed_step_results),
    )


async def _drive_steps(
    req: RunRequest,
    request: Request,
    session: Any,
    completed_step_results: list[StepResult],
) -> AsyncIterator[Any]:
    """Per-step driver. Yields step_started/step_finished/run_paused events.

    Caller handles the run-level state (overall_status, healthy, error_class)
    based on the events emitted here. We never raise — every per-step crash
    becomes a `failed` StepResult so the SSE stream stays clean.
    """
    for step in req.flow.steps:
        if await request.is_disconnected():
            log.warning("[FLOWLENS:client_disconnected]", runId=req.runId, stepIndex=step.index)
            return

        log.info(
            "[FLOWLENS:step_started]",
            runId=req.runId,
            stepIndex=step.index,
            action=step.action,
            intent=step.intent[:80],
            isCritical=step.isCritical,
        )
        yield StepStartedEvent(runId=req.runId, stepIndex=step.index)
        started = time.monotonic()
        try:
            result = await _execute_step(session, req, step)
        except Exception as e:
            # Per-step crash (e.g. browser-use tools.act() raised, or judge_step
            # blew up with a malformed response). Treat as a failed step and
            # keep the run going — the user gets to see which step broke.
            log.error(
                "step_execute_failed",
                runId=req.runId,
                stepIndex=step.index,
                error=str(e),
            )
            result = StepResult(
                runId=req.runId,
                stepIndex=step.index,
                status="failed",
                durationMs=int((time.monotonic() - started) * 1000),
                selectorResolvedVia=None,
                replayScreenshotBlobKey=None,
                judge=None,
                consoleErrors=[],
                networkErrors=[],
                llmStepsUsed=0,
                llmCostUsdMicro=0,
                errorMessage=f"replay-worker exception: {e}",
            )
        else:
            result.durationMs = int((time.monotonic() - started) * 1000)
        completed_step_results.append(result)
        log.info(
            "[FLOWLENS:step_finished]",
            runId=req.runId,
            stepIndex=step.index,
            status=result.status,
            durationMs=result.durationMs,
            via=result.selectorResolvedVia,
            err=(result.errorMessage[:120] if result.errorMessage else None),
        )
        yield StepFinishedEvent(result=result)

        # Auth-wall detection: pause workflow if the replay redirected to login.
        # Use the simple_replay CDP probe (no browser-use event bus dependency).
        try:
            is_auth_wall, hint = await quick_auth_probe(session)
        except Exception as e:
            log.warning("[FLOWLENS:auth_wall_probe_failed]", runId=req.runId, error=str(e))
            is_auth_wall, hint = False, None
        if is_auth_wall:
            log.warning("auth_wall_detected", runId=req.runId, stepIndex=step.index, hint=hint)
            yield RunPausedEvent(
                runId=req.runId,
                reason="auth",
                hint=hint or "auth wall detected",
                blockedAtStepIndex=step.index,
            )
            return  # caller observes RunPausedEvent and stops emitting more events

        if result.status in ("failed", "blocked_auth", "errored") and step.isCritical:
            log.warning(
                "critical_step_failed",
                runId=req.runId,
                stepIndex=step.index,
                status=result.status,
            )
            return


async def _execute_step(session: Any, req: RunRequest, step: FlowStep) -> StepResult:
    """Execute one step.

    Default path: `simple_replay.execute_simple` — raw CDP, no Agent loop.
    This is robust under parallel execution (the Agent loop is not, see
    `simple_replay.py`'s docstring for the full writeup).

    Mode `full_llm` keeps the Agent path for environments where the
    Agent's vision-based fallback is required.
    """
    settings = get_settings()
    error_message: str | None = None
    selector_via: str | None = None
    llm_steps_used = 0
    llm_cost_usd_micro = 0

    if req.mode.name == "full_llm":
        # Legacy Agent path — used when the caller explicitly asks for it.
        agent_result = await run_agent_step(
            session, req.flow, step, sensitive_data=req.sensitiveData
        )
        llm_steps_used = int(agent_result.get("steps_used", 0))
        prompt_tokens = int(agent_result.get("prompt_tokens", 0))
        completion_tokens = int(agent_result.get("completion_tokens", 0))
        llm_cost_usd_micro = estimate_cost_usd_micro(
            settings.flowlens_model_replay_agent, prompt_tokens, completion_tokens
        )
        selector_via = "llm"
        if not agent_result.get("success", False):
            error_message = str(agent_result.get("error") or "agent step did not complete")
    else:
        # Default: simple-replay (raw CDP). Deterministic + parallel-safe.
        try:
            simple_result = await execute_simple(session, step)
            selector_via = "css" if step.selectors.css else "xpath" if step.selectors.xpath else "testid"
            log.info(
                "[FLOWLENS:simple_step_ok]",
                runId=req.runId,
                stepIndex=step.index,
                action=step.action,
                via=selector_via,
                urlAfter=simple_result.get("urlAfter"),
            )
        except SimpleReplayError as e:
            log.warning(
                "[FLOWLENS:simple_step_failed]",
                runId=req.runId,
                stepIndex=step.index,
                action=step.action,
                error=str(e),
            )
            error_message = str(e)
            selector_via = "recorded-only"

    # Capture a post-step viewport screenshot regardless of whether the
    # step itself succeeded — the side panel needs to show "what the page
    # looked like when this failed" just as much as the success case. The
    # helper swallows its own errors and returns None on any CDP failure
    # so a flaky screenshot never turns a passing step into a failure.
    screenshot_b64 = await capture_screenshot(session)

    # T3 judge for critical steps.
    # Disabled when FLOWLENS_DISABLE_JUDGE is set — we ran into hard RPM=3
    # caps on gpt-4.1-mini during 5-parallel matrix runs, which blocked
    # the SSE pipeline. The matrix view doesn't depend on per-step judge
    # verdicts (the cluster summary at the batch level is what users see).
    judge_verdict: JudgeVerdict | None = None
    judge_disabled = bool(os_environ_get("FLOWLENS_DISABLE_JUDGE", ""))
    if step.isCritical and not error_message and not judge_disabled:
        try:
            judge_verdict = await judge_step(
                run_id=req.runId,
                step_index=step.index,
                expected_outcome=step.expectedOutcome,
                action_summary=f"{step.action} (intent: {step.intent})",
                recorded_screenshot_url=req.recordedScreenshotsByIndex.get(step.index),
                replay_screenshot_url=None,  # captured in apps/web after the SSE stream completes
            )
        except Exception as e:
            log.warning(
                "[FLOWLENS:judge_failed]",
                runId=req.runId,
                stepIndex=step.index,
                error=str(e),
            )

    # Decide step status. Order: explicit error → judge fail → success.
    status: str
    if error_message:
        status = "failed"
    elif judge_verdict is not None and judge_verdict.verdict == "fail":
        status = "failed"
        error_message = judge_verdict.reason
    else:
        status = "passed"

    return StepResult(
        runId=req.runId,
        stepIndex=step.index,
        status=status,  # type: ignore[arg-type]
        durationMs=0,  # filled in by caller
        selectorResolvedVia=selector_via,  # type: ignore[arg-type]
        replayScreenshotBlobKey=None,  # web side stamps this after uploading the b64 below
        replayScreenshotPngB64=screenshot_b64,
        judge=judge_verdict,
        consoleErrors=[],
        networkErrors=[],
        llmStepsUsed=llm_steps_used,
        llmCostUsdMicro=llm_cost_usd_micro,
        errorMessage=error_message,
    )


def _compute_health_score(results: list[StepResult], healthy: bool) -> int:
    if not results:
        return 0
    passed = sum(1 for r in results if r.status == "passed")
    base = round((passed / len(results)) * 100)
    if not healthy:
        base = max(0, base - 5)  # drift penalty
    return min(100, max(0, base))


def _compute_summary(flow: Flow, results: list[StepResult], status: str) -> str:
    if status == "passed":
        return f"All {len(results)} steps of {flow.name} completed successfully."
    failed = next((r for r in results if r.status in ("failed", "errored")), None)
    if failed and failed.errorMessage:
        step = flow.steps[failed.stepIndex] if failed.stepIndex < len(flow.steps) else None
        intent = step.intent if step else f"step {failed.stepIndex}"
        return f"Failed at: {intent} — {failed.errorMessage[:200]}"
    return f"Run ended with status {status}."


async def _safe_stop(session: Any) -> None:
    try:
        if hasattr(session, "stop"):
            await asyncio.wait_for(session.stop(), timeout=10)
    except Exception as e:
        log.warning("session_stop_failed", error=str(e))
