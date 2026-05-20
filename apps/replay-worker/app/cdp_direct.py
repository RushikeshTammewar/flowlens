"""Non-LLM step execution via browser-use's `tools.act()`.

This is the FAST path: when the recorded selector resolves cleanly to a live
`backend_node_id` AND the step is not critical, we skip the Agent loop entirely
and dispatch a single CDP click/input/etc. directly. Cost per step ≈ $0.001
(browser session only — no LLM).

Falls back to the Agent loop on any unexpected failure.
"""
from __future__ import annotations

from typing import Any

from .contracts import FlowStep


class CdpDirectError(RuntimeError):
    pass


async def execute_cdp_direct(
    session: Any,
    step: FlowStep,
    backend_node_id: int,
    value: str | None,
) -> None:
    """Execute the step's action against `backend_node_id` via tools.act().

    Raises `CdpDirectError` on any failure so the caller can fall through to
    the Agent loop without losing the step. We never raise non-fatal errors
    from here — partial successes count as failures.
    """
    from browser_use import Tools  # type: ignore[import-not-found]

    tools = Tools()
    action_model_cls = tools.registry.create_action_model()

    try:
        if step.action == "click":
            action = action_model_cls(click={"index": backend_node_id})
        elif step.action == "input":
            if value is None:
                raise CdpDirectError("input action requires value")
            action = action_model_cls(input={"index": backend_node_id, "text": value})
        elif step.action == "select":
            if value is None:
                raise CdpDirectError("select action requires value")
            action = action_model_cls(select_dropdown={"index": backend_node_id, "option": value})
        elif step.action == "keypress":
            action = action_model_cls(send_keys={"keys": value or "Enter"})
        elif step.action == "scroll":
            action = action_model_cls(scroll={"down": True})
        elif step.action == "navigate":
            if not step.url:
                raise CdpDirectError("navigate action requires url")
            action = action_model_cls(navigate={"url": step.url})
        elif step.action == "wait":
            action = action_model_cls(wait={"seconds": 1})
        elif step.action == "assert":
            # Pure assertions don't change the page; the T1+T3 verifiers handle
            # them upstream. Skip the CDP dispatch.
            return
        else:
            raise CdpDirectError(f"unsupported action {step.action}")
    except Exception as e:
        raise CdpDirectError(f"failed to build action model: {e}") from e

    try:
        result = await tools.act(action, browser_session=session)
    except Exception as e:
        raise CdpDirectError(f"tools.act() failed: {e}") from e

    # browser-use returns an ActionResult — we only treat explicit error or
    # `is_done=False` with `error` set as failures. Empty/successful results
    # are fine.
    if hasattr(result, "error") and getattr(result, "error", None):
        raise CdpDirectError(str(result.error))
