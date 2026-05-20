"""Settings loaded from environment.

Mirrors `packages/llm-config/src/index.ts` for the small subset the worker
uses. Everything else (Postgres, Vercel Blob, Clerk) is owned by apps/web
and the worker does not need credentials for those services.
"""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env.local", extra="ignore")

    log_level: str = "info"

    # Auth between apps/web (TS) and the worker (Python). Bearer token in the
    # Authorization header. Rotate any time without coordinated downtime: web
    # writes the new value to env, restart it, then restart the worker — the
    # only window of failure is in-flight requests.
    replay_worker_shared_secret: str = ""

    # ─── LLM provider routing ────────────────────────────────────────────
    # `openai` (default) hits api.openai.com. `azure_foundry` routes every
    # call to Azure AI Foundry (Azure OpenAI deployments). Mirror of
    # packages/llm-config/src/provider.ts.
    llm_provider: str = "openai"

    # OpenAI direct (used when llm_provider == 'openai').
    openai_api_key: str = ""

    # Azure AI Foundry (used when llm_provider == 'azure_foundry').
    # Endpoint format: https://<resource>.services.ai.azure.com/api/projects/<project>
    # The control-plane suffix `/api/projects/<project>` is stripped before
    # building inference URLs (see app/llm_client.py).
    azure_foundry_endpoint: str = ""
    azure_foundry_api_key: str = ""
    azure_foundry_subscription_id: str = ""
    azure_foundry_resource_group: str = ""
    azure_foundry_project: str = ""
    azure_foundry_api_version: str = "2024-12-01-preview"

    # Browser Use Cloud — browser-use reads this directly when it talks to BU.
    browser_use_api_key: str = ""

    # Mirrors @flowlens/llm-config TS table. Kept for backward-compat callers
    # that still read these directly; the canonical lookup is
    # `app.llm_client.model_for(stage)` which is provider-aware.
    flowlens_model_replay_agent: str = ""
    flowlens_model_judge: str = ""

    # Browser-use behaviour knobs (LLD §5.5).
    max_clickable_elements_length: int = 25_000
    llm_screenshot_size_w: int = 1024
    llm_screenshot_size_h: int = 768


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
