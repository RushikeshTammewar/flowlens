"""LLM-driven step execution.

Wraps `browser_use.Agent` with the Flowlens config from LLD §5.5:
  - browser-use ChatOpenAI / ChatAzureOpenAI (selected by LLM_PROVIDER) with
    vision='auto', flash_mode=False
  - tightened max_clickable_elements_length to keep prompts cheap
  - include_attributes covers our four selector tiers + data-flowlens-id
  - max_steps small (3 non-critical, 5 critical)

The recording acts as a STRONG PRIOR: we pass the recorded screenshot as a
reference image and the recorded selector strings as hints inside the task
prompt. The LLM still re-decides per step against the live DOM.
"""
from __future__ import annotations

from typing import Any, cast

from .config import get_settings
from .contracts import FlowStep, Flow
from .llm_client import build_browser_use_llm, model_for


def build_agent_task(step: FlowStep, flow: Flow) -> str:
    """Compose the task prompt fed to the Agent for one micro-step."""
    selector_lines = []
    if step.selectors.testid:
        selector_lines.append(f"  testid: {step.selectors.testid}")
    if step.selectors.flowlensId:
        selector_lines.append(f"  data-flowlens-id: {step.selectors.flowlensId}")
    if step.selectors.role:
        selector_lines.append(f"  role: {step.selectors.role}")
    if step.selectors.accessibleName:
        selector_lines.append(f"  accessibleName: {step.selectors.accessibleName!r}")
    if step.selectors.css:
        selector_lines.append(f"  css: {step.selectors.css}")
    if step.selectors.xpath:
        selector_lines.append(f"  xpath: {step.selectors.xpath}")
    selector_block = "\n".join(selector_lines) if selector_lines else "  (no recorded selectors)"

    return (
        f"Goal of the overall flow: {flow.name}\n"
        f"This step ({step.index + 1} of {len(flow.steps)}): {step.intent}\n"
        f"Expected outcome of this step: {step.expectedOutcome}\n\n"
        "When the user originally recorded this flow, this step was performed on the element matching:\n"
        f"{selector_block}\n\n"
        "If the page looks substantially the same as during recording, do exactly what the user did.\n"
        "If the UI has changed but the intent is still achievable, find the equivalent element and complete the same intent.\n"
        "If the intent is no longer achievable, report failure with a clear reason.\n"
    )


async def run_agent_step(
    session: Any,
    flow: Flow,
    step: FlowStep,
    *,
    sensitive_data: dict[str, str],
) -> dict[str, Any]:
    """Run a single browser-use Agent loop scoped to one step.

    Returns a dict with `success`, `steps_used`, `error`, `screenshot_b64`,
    `dom_hash` so the caller can compose a `StepResult`.
    """
    from browser_use import Agent  # type: ignore[import-not-found]

    settings = get_settings()

    task = build_agent_task(step, flow)
    # Provider-aware: returns ChatOpenAI when LLM_PROVIDER=openai, or
    # ChatAzureOpenAI when LLM_PROVIDER=azure_foundry. `model` is the
    # deployment name on Azure, the model id on OpenAI.
    llm = build_browser_use_llm(model=model_for("replayAgent"))

    agent = Agent(
        task=task,
        llm=llm,
        browser_session=session,
        # See LLD §5.5 for the full rationale on each knob.
        use_vision="auto",
        use_thinking=step.isCritical,
        use_judge=False,
        max_steps=5 if step.isCritical else 3,
        max_actions_per_step=3,
        max_failures=2,
        step_timeout=60,
        llm_timeout=30,
        llm_screenshot_size=(settings.llm_screenshot_size_w, settings.llm_screenshot_size_h),
        vision_detail_level="low",
        include_attributes=[
            "role", "aria-label", "aria-labelledby", "name",
            "placeholder", "title", "alt", "value", "type",
            "data-testid", "data-test", "data-cy", "data-flowlens-id",
        ],
        max_clickable_elements_length=settings.max_clickable_elements_length,
        sensitive_data=sensitive_data,
    )

    try:
        history = await agent.run()
    except Exception as e:
        return {"success": False, "steps_used": 0, "error": str(e)}

    is_done = history.is_done() if hasattr(history, "is_done") else True
    last_entry = history.history[-1] if history.history else None
    last_result = (
        last_entry.result[-1] if last_entry and getattr(last_entry, "result", None) else None
    )
    success = bool(getattr(last_result, "success", is_done))
    error = getattr(last_result, "error", None)

    # Token usage — browser-use 0.12.6 exposes `usage` as a `UsageSummary`
    # Pydantic model (NOT a dict). Fields:
    #   total_prompt_tokens, total_completion_tokens, total_tokens, total_cost.
    # Older versions exposed a plain dict with prompt_tokens/input_tokens.
    # We probe both shapes safely.
    prompt_tokens = 0
    completion_tokens = 0
    raw_usage = getattr(history, "usage", None)
    if raw_usage is not None:
        if hasattr(raw_usage, "total_prompt_tokens"):
            # UsageSummary BaseModel (current shape)
            prompt_tokens = int(getattr(raw_usage, "total_prompt_tokens", 0) or 0)
            completion_tokens = int(getattr(raw_usage, "total_completion_tokens", 0) or 0)
        elif isinstance(raw_usage, dict):
            # Legacy dict shape
            prompt_tokens = int(raw_usage.get("prompt_tokens", raw_usage.get("input_tokens", 0)) or 0)
            completion_tokens = int(
                raw_usage.get("completion_tokens", raw_usage.get("output_tokens", 0)) or 0
            )

    return {
        "success": success,
        "steps_used": len(history.history),
        "error": error,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
    }
