"""Structured logging.

Every line is a single JSON object with stable keys: `event`, `runId`,
`stepIndex`, `model`, `tokens`, `costUsdMicro`, `durationMs`, `level`.

Aggregators (Vercel Observability, Datadog, AWS CloudWatch, Azure Monitor)
treat these as structured events out of the box.
"""
from __future__ import annotations

import logging
from typing import Any

import structlog


def configure_logging(level: str) -> None:
    log_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        format="%(message)s",
        stream=__import__("sys").stdout,
        level=log_level,
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        cache_logger_on_first_use=True,
    )


log: structlog.stdlib.BoundLogger = structlog.get_logger("flowlens.replay")


def log_llm_call(
    *,
    run_id: str,
    step_index: int | None,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cost_usd_micro: int,
    duration_ms: int,
    purpose: str,
    extra: dict[str, Any] | None = None,
) -> None:
    log.info(
        "llm_call",
        runId=run_id,
        stepIndex=step_index,
        model=model,
        promptTokens=prompt_tokens,
        completionTokens=completion_tokens,
        totalTokens=prompt_tokens + completion_tokens,
        costUsdMicro=cost_usd_micro,
        durationMs=duration_ms,
        purpose=purpose,
        **(extra or {}),
    )


# Pricing table mirrors apps/web compile-runner.ts. Keep in sync.
TOKEN_PRICE_USD_MICRO_PER_M_INPUT: dict[str, int] = {
    "gpt-4.1-mini": 400,
    "gpt-4.1": 2_500,
    "o4-mini": 1_100,
}
TOKEN_PRICE_USD_MICRO_PER_M_OUTPUT: dict[str, int] = {
    "gpt-4.1-mini": 1_600,
    "gpt-4.1": 10_000,
    "o4-mini": 4_400,
}


def estimate_cost_usd_micro(model: str, prompt_tokens: int, completion_tokens: int) -> int:
    in_rate = TOKEN_PRICE_USD_MICRO_PER_M_INPUT.get(model, 1_000)
    out_rate = TOKEN_PRICE_USD_MICRO_PER_M_OUTPUT.get(model, 5_000)
    return round(
        (prompt_tokens / 1_000_000) * in_rate + (completion_tokens / 1_000_000) * out_rate
    )
