"""Provider-aware LLM client for the Python sidecar.

Mirror of `packages/llm-config/src/{index,client}.ts`. Keep both in sync.

Routing decision (`LLM_PROVIDER` env):
  - `azure_foundry` → `AsyncAzureOpenAI` against the Foundry resource. The
    `model` field is treated as the deployment NAME you created in Foundry
    Studio (NOT the base model id).
  - anything else / unset → `AsyncOpenAI` against api.openai.com.

Both shapes expose identical `chat.completions.create(...)` /
`chat.completions.parse(...)` so call sites in `judge.py`, etc. don't change.

For the browser-use Agent (`agent_step.py`) we use browser-use's own
`ChatOpenAI` / `ChatAzureOpenAI` shims because that's what the Agent class
expects — see `_build_agent_llm()` below.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Literal

from openai import AsyncAzureOpenAI, AsyncOpenAI

from .config import get_settings

LlmProvider = Literal["openai", "azure"]

# Mirror of MODEL_TABLE in packages/llm-config/src/index.ts. Keep names AND
# values in sync — this dict is the source of truth for the Python sidecar.
MODEL_TABLE: dict[str, dict[LlmProvider, str]] = {
    "narrate": {"openai": "gpt-4.1-mini", "azure": "gpt-5.4-mini"},
    "synthesize": {"openai": "gpt-4.1", "azure": "gpt-4.1"},
    "replayAgent": {"openai": "gpt-4.1-mini", "azure": "gpt-5.4-mini"},
    "judge": {"openai": "gpt-4.1-mini", "azure": "gpt-5.4-mini"},
    "investigator": {"openai": "o4-mini", "azure": "o4-mini"},
    "siteModel": {"openai": "gpt-4.1", "azure": "gpt-5.4"},
    "dataGen": {"openai": "gpt-4.1-mini", "azure": "gpt-5.4-mini"},
    "siblingGen": {"openai": "gpt-4.1-mini", "azure": "gpt-5.4-mini"},
    "driftAnalyzer": {"openai": "gpt-4.1", "azure": "gpt-4.1"},
    "sensitiveClassifier": {"openai": "gpt-4.1-mini", "azure": "gpt-5.4-mini"},
    "matrixGenerator": {"openai": "o3", "azure": "gpt-5.4"},
    "matrixGeneratorFallback": {"openai": "o4-mini", "azure": "o4-mini"},
    "matrixCluster": {"openai": "o4-mini", "azure": "gpt-5.4-mini"},
}

DEFAULT_AZURE_API_VERSION = "2024-12-01-preview"


def _camel_to_screaming_snake(s: str) -> str:
    out: list[str] = []
    for c in s:
        if c.isupper():
            out.append("_")
        out.append(c.upper())
    return "".join(out)


# Legacy env aliases (mirror packages/llm-config/src/index.ts).
LEGACY_ALIASES: dict[str, str] = {
    "driftAnalyzer": "FLOWLENS_MODEL_DRIFT",
    "sensitiveClassifier": "FLOWLENS_MODEL_SENSITIVE",
    "matrixGeneratorFallback": "FLOWLENS_MODEL_MATRIX_FALLBACK",
}


def get_provider() -> LlmProvider:
    """Resolve provider from env or Settings (`.env.local`).

    Order:
      1. `LLM_PROVIDER` os.environ (CI / shell override always wins).
      2. `Settings.llm_provider` loaded from `.env.local` by pydantic_settings.
    Defaults to `openai` if neither is set.
    """
    raw = (os.getenv("LLM_PROVIDER") or "").strip().lower()
    if not raw:
        try:
            raw = (get_settings().llm_provider or "").strip().lower()
        except Exception:
            raw = ""
    if raw in ("azure_foundry", "azure"):
        return "azure"
    return "openai"


def model_for(stage: str) -> str:
    """Resolve a stage to the concrete model/deployment name for the active
    provider. Per-stage `FLOWLENS_MODEL_<STAGE>` env overrides win.

    Mirrors `modelFor()` in packages/llm-config/src/index.ts.
    """
    if stage not in MODEL_TABLE:
        raise KeyError(f"unknown LLM stage: {stage!r}")
    canonical = os.getenv(f"FLOWLENS_MODEL_{_camel_to_screaming_snake(stage)}")
    if canonical and canonical.strip():
        return canonical.strip()
    legacy_key = LEGACY_ALIASES.get(stage)
    if legacy_key:
        legacy = os.getenv(legacy_key)
        if legacy and legacy.strip():
            return legacy.strip()
    provider = get_provider()
    return MODEL_TABLE[stage][provider]


def _azure_inference_base(raw_endpoint: str) -> str:
    """Strip `/api/projects/<project>` so AsyncAzureOpenAI builds the right
    `<base>/openai/deployments/<deployment>/chat/completions` URL."""
    base = raw_endpoint
    if "/api/projects/" in base:
        base = base.split("/api/projects/")[0]
    return base.rstrip("/")


@lru_cache(maxsize=1)
def _cached_openai_client() -> AsyncOpenAI:
    settings = get_settings()
    api_key = settings.openai_api_key or os.getenv("OPENAI_API_KEY") or ""
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is required (or set LLM_PROVIDER=azure_foundry)."
        )
    return AsyncOpenAI(api_key=api_key)


@lru_cache(maxsize=1)
def _cached_azure_client() -> AsyncAzureOpenAI:
    settings = get_settings()
    endpoint = (
        settings.azure_foundry_endpoint
        or os.getenv("AZURE_FOUNDRY_ENDPOINT")
        or os.getenv("AZURE_OPENAI_ENDPOINT")
        or ""
    )
    api_key = (
        settings.azure_foundry_api_key
        or os.getenv("AZURE_FOUNDRY_API_KEY")
        or os.getenv("AZURE_OPENAI_API_KEY")
        or ""
    )
    if not endpoint:
        raise RuntimeError(
            "LLM_PROVIDER=azure_foundry but AZURE_FOUNDRY_ENDPOINT is not set."
        )
    if not api_key:
        raise RuntimeError(
            "LLM_PROVIDER=azure_foundry but AZURE_FOUNDRY_API_KEY is not set."
        )
    api_version = (
        settings.azure_foundry_api_version
        or os.getenv("AZURE_FOUNDRY_API_VERSION")
        or DEFAULT_AZURE_API_VERSION
    )
    return AsyncAzureOpenAI(
        azure_endpoint=_azure_inference_base(endpoint),
        api_key=api_key,
        api_version=api_version,
    )


def get_llm_client() -> AsyncOpenAI:
    """Return a singleton OpenAI-compatible async client for the active
    provider. `AsyncAzureOpenAI` extends `AsyncOpenAI` so callers can type
    against the parent.
    """
    if get_provider() == "azure":
        return _cached_azure_client()
    return _cached_openai_client()


def reset_clients() -> None:
    """Clear cached clients. Useful in tests when flipping LLM_PROVIDER."""
    _cached_openai_client.cache_clear()
    _cached_azure_client.cache_clear()


def build_browser_use_llm(*, model: str, vision: str = "auto") -> Any:
    """Build the LLM instance browser-use's Agent expects.

    browser-use ships provider-specific shims (`ChatOpenAI`, `ChatAzureOpenAI`)
    that wrap the OpenAI/AzureOpenAI clients with browser-use-specific
    serialization. They share the `model=` argument shape so the upstream
    `agent_step.py` code doesn't care which is used.
    """
    settings = get_settings()
    provider = get_provider()
    if provider == "azure":
        from browser_use.llm import ChatAzureOpenAI  # type: ignore[import-not-found]

        endpoint = settings.azure_foundry_endpoint or os.getenv("AZURE_FOUNDRY_ENDPOINT") or ""
        api_key = settings.azure_foundry_api_key or os.getenv("AZURE_FOUNDRY_API_KEY") or ""
        api_version = (
            settings.azure_foundry_api_version
            or os.getenv("AZURE_FOUNDRY_API_VERSION")
            or DEFAULT_AZURE_API_VERSION
        )
        return ChatAzureOpenAI(
            model=model,
            api_key=api_key,
            azure_endpoint=_azure_inference_base(endpoint),
            api_version=api_version,
        )
    from browser_use.llm import ChatOpenAI  # type: ignore[import-not-found]

    return ChatOpenAI(model=model, api_key=settings.openai_api_key)
