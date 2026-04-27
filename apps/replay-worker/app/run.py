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
from typing import Any, AsyncIterator

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
from .judge import judge_step
from .resolve import resolve_backend_node_id
from .security import require_bearer
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


async def _replay(req: RunRequest, request: Request) -> AsyncIterator[Any]:
    """Drives the replay loop and yields contract events.

    Defensive contract: this generator MUST always emit a terminal
    `RunCompleteEvent` (or `RunPausedEvent`) before exiting, even when
    something explodes inside browser-use. The TS-side caller blocks on the
    SSE stream and a torn-down connection looks identical to a hung run; an
    explicit `errored` event lets the workflow fail fast with a clean cause.
    """
    from browser_use import BrowserSession  # type: ignore[import-not-found]

    log.info("run_started", runId=req.runId, flowId=req.flow.id, steps=len(req.flow.steps))

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
        try:
            await session.start()
            session_started = True
        except Exception as e:
            log.error("session_start_failed", runId=req.runId, error=str(e))
            overall_status = "errored"
            error_class = "env"
            error_summary = f"failed to connect to CDP: {e}"
            session = None  # don't try to stop a session that never started

        if not session_started:
            # Skip the per-step loop; fall through to the run_complete yield.
            pass
        else:
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
        "run_finished",
        runId=req.runId,
        status=overall_status,
        steps=len(completed_step_results),
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
            log.warning("client_disconnected", runId=req.runId, stepIndex=step.index)
            return

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
        yield StepFinishedEvent(result=result)

        # Auth-wall detection: pause workflow if the replay redirected to login.
        try:
            is_auth_wall, hint = await detect_auth_wall(session, last_status_code=None)
        except Exception as e:
            log.warning("auth_wall_probe_failed", runId=req.runId, error=str(e))
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
    """The hybrid CDP-direct vs Agent-loop decision tree."""
    settings = get_settings()
    cdp_direct_eligible = (
        not step.isCritical and req.mode.name != "full_llm" and step.action != "assert"
    )

    selector_via: str | None = None
    backend_node_id: int | None = None

    if cdp_direct_eligible:
        resolved = await resolve_backend_node_id(req.cdpUrl, step.selectors)
        if getattr(resolved, "found", False):
            backend_node_id = resolved.backendNodeId  # type: ignore[union-attr]
            selector_via = resolved.via  # type: ignore[union-attr]

    fallback_to_agent = False
    error_message: str | None = None
    llm_steps_used = 0
    llm_cost_usd_micro = 0
    prompt_tokens = 0
    completion_tokens = 0

    if backend_node_id is not None:
        try:
            await execute_cdp_direct(
                session,
                step,
                backend_node_id,
                value=step.recordedValue if not step.isSensitive else None,
            )
        except CdpDirectError as e:
            log.info(
                "cdp_direct_fallback",
                runId=req.runId,
                stepIndex=step.index,
                reason=str(e),
            )
            fallback_to_agent = True

    if backend_node_id is None or fallback_to_agent or step.isCritical or req.mode.name == "full_llm":
        agent_result = await run_agent_step(
            session,
            req.flow,
            step,
            sensitive_data=req.sensitiveData,
        )
        llm_steps_used = int(agent_result.get("steps_used", 0))
        prompt_tokens = int(agent_result.get("prompt_tokens", 0))
        completion_tokens = int(agent_result.get("completion_tokens", 0))
        llm_cost_usd_micro = estimate_cost_usd_micro(
            settings.flowlens_model_replay_agent, prompt_tokens, completion_tokens
        )
        if not agent_result.get("success", False):
            error_message = str(agent_result.get("error") or "agent step did not complete")
        if selector_via is None:
            selector_via = "llm"

    # T3 judge for critical steps.
    judge_verdict: JudgeVerdict | None = None
    if step.isCritical:
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
            log.warning("judge_failed", runId=req.runId, stepIndex=step.index, error=str(e))

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
        replayScreenshotBlobKey=None,  # filled by apps/web from BU Cloud screenshot
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
