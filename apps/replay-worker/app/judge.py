"""T3 AI judge — yes/no verdict on whether a critical step achieved its
expected outcome. Called only on critical steps (cost guardrail).
"""
from __future__ import annotations

import json
import time
from typing import Any

from .contracts import JudgeVerdict
from .llm_client import get_llm_client, get_provider, model_for
from .telemetry import estimate_cost_usd_micro, log_llm_call


_JUDGE_SYSTEM_PROMPT = """You are an automated QA judge. Decide whether a single test step achieved its expected outcome.

Inputs: the original recording's screenshot, the replay's screenshot, the action that was attempted, and the expected outcome.

Output strict JSON: { "verdict": "pass" | "fail", "reason": "<= 1 sentence", "confidence": 0..1 }.

Be strict but fair: small visual differences (animations, A/B variants, personalization) do NOT count as failure. The intent succeeding is what matters."""


async def judge_step(
    *,
    run_id: str,
    step_index: int,
    expected_outcome: str,
    action_summary: str,
    recorded_screenshot_url: str | None,
    replay_screenshot_url: str | None,
) -> JudgeVerdict:
    client = get_llm_client()
    judge_model = model_for("judge")

    user_parts: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                f"Action attempted: {action_summary}\n"
                f"Expected outcome: {expected_outcome}\n"
                "First image is the original recording. Second image is the replay."
            ),
        }
    ]
    if recorded_screenshot_url:
        user_parts.append(
            {"type": "image_url", "image_url": {"url": recorded_screenshot_url, "detail": "low"}}
        )
    if replay_screenshot_url:
        user_parts.append(
            {"type": "image_url", "image_url": {"url": replay_screenshot_url, "detail": "low"}}
        )

    started = time.monotonic()
    response = await client.chat.completions.create(
        model=judge_model,
        messages=[
            {"role": "system", "content": _JUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": user_parts},
        ],
        response_format={"type": "json_object"},
        max_completion_tokens=200,
    )
    duration_ms = int((time.monotonic() - started) * 1000)

    usage = response.usage
    prompt_tokens = usage.prompt_tokens if usage else 0
    completion_tokens = usage.completion_tokens if usage else 0
    cost_usd_micro = estimate_cost_usd_micro(
        judge_model, prompt_tokens, completion_tokens
    )
    log_llm_call(
        run_id=run_id,
        step_index=step_index,
        model=f"{get_provider()}/{judge_model}",
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cost_usd_micro=cost_usd_micro,
        duration_ms=duration_ms,
        purpose="t3_judge",
    )

    raw = response.choices[0].message.content or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return JudgeVerdict(verdict="fail", reason=f"judge returned non-JSON: {raw[:120]}", confidence=0.0)

    verdict_str = str(data.get("verdict", "fail")).lower()
    if verdict_str not in ("pass", "fail"):
        verdict_str = "fail"
    confidence_raw = data.get("confidence", 0.5)
    try:
        confidence = max(0.0, min(1.0, float(confidence_raw)))
    except (TypeError, ValueError):
        confidence = 0.5

    return JudgeVerdict(
        verdict=verdict_str,  # type: ignore[arg-type]
        reason=str(data.get("reason", "no reason given"))[:280],
        confidence=confidence,
    )
