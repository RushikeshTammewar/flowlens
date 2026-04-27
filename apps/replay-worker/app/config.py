"""Settings loaded from environment.

Mirrors `apps/web/src/lib/models.ts` for the small subset the worker uses.
Everything else (Postgres, Vercel Blob, Clerk) is owned by apps/web and the
worker does not need credentials for those services.
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

    # OpenAI for the Agent LLM + the T3 judge.
    openai_api_key: str = ""

    # Browser Use Cloud — browser-use reads this directly when it talks to BU.
    browser_use_api_key: str = ""

    # Mirrors @flowlens/llm-config TS table. Keep names + defaults in sync.
    flowlens_model_replay_agent: str = "gpt-4.1-mini"
    flowlens_model_judge: str = "gpt-4.1-mini"

    # Browser-use behaviour knobs (LLD §5.5).
    max_clickable_elements_length: int = 25_000
    llm_screenshot_size_w: int = 1024
    llm_screenshot_size_h: int = 768


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
