"""Request / response contracts shared with the TS caller.

Field names MUST match `packages/replay-engine/src/types.ts` exactly so the
Pydantic models on this side and the Zod schemas on the TS side can share a
serialization. We do not use `aliasing` — keep the camelCase names on the wire.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class HardenedSelectors(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    role: str | None = None
    accessibleName: str | None = None
    testid: str | None = None
    css: str | None = None
    xpath: str | None = None
    flowlensId: str | None = None


FlowStepAction = Literal[
    "navigate", "click", "input", "select", "keypress", "wait", "assert", "scroll"
]


class FlowStep(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    index: int
    action: FlowStepAction
    intent: str
    expectedOutcome: str
    isCritical: bool
    selectors: HardenedSelectors
    recordedValue: str | None = None
    isSensitive: bool = False
    recordedScreenshotKey: str = ""
    url: str | None = None


class Flow(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: str
    name: str
    siteOrigin: str
    steps: list[FlowStep]


# ─── /run request/response ───────────────────────────────────────────────────


class RunMode(BaseModel):
    """Which path to prefer per step."""

    model_config = ConfigDict(extra="ignore")

    name: Literal["hybrid", "fast", "full_llm"] = "hybrid"


class RunRequest(BaseModel):
    """Body of POST /run."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    runId: str
    flow: Flow
    cdpUrl: str
    liveUrl: str | None = None
    mode: RunMode = RunMode()
    # Resolved screenshot URLs by actionIndex — caller computes these from blob keys.
    recordedScreenshotsByIndex: dict[int, str] = Field(default_factory=dict)
    # Sensitive data (decrypted by caller, passed only for the duration of this run).
    sensitiveData: dict[str, str] = Field(default_factory=dict)


# ─── SSE event payloads ──────────────────────────────────────────────────────


class StepStartedEvent(BaseModel):
    type: Literal["step_started"] = "step_started"
    runId: str
    stepIndex: int


SelectorResolvedVia = Literal[
    "testid", "role-name", "css", "xpath", "flowlens-id", "llm", "recorded-only"
]


class JudgeVerdict(BaseModel):
    verdict: Literal["pass", "fail"]
    reason: str
    confidence: float


StepStatus = Literal[
    "passed", "failed", "flaky", "blocked_auth", "inconclusive", "skipped"
]


class StepResult(BaseModel):
    runId: str
    stepIndex: int
    status: StepStatus
    durationMs: int
    selectorResolvedVia: SelectorResolvedVia | None = None
    replayScreenshotBlobKey: str | None = None
    judge: JudgeVerdict | None = None
    consoleErrors: list[str] = Field(default_factory=list)
    networkErrors: list[dict[str, object]] = Field(default_factory=list)
    llmStepsUsed: int = 0
    llmCostUsdMicro: int = 0
    errorMessage: str | None = None


class StepFinishedEvent(BaseModel):
    type: Literal["step_finished"] = "step_finished"
    result: StepResult


class RunPausedEvent(BaseModel):
    type: Literal["run_paused"] = "run_paused"
    runId: str
    reason: Literal["auth", "user"]
    hint: str
    blockedAtStepIndex: int


class RunCompleteEvent(BaseModel):
    type: Literal["run_complete"] = "run_complete"
    runId: str
    status: Literal["passed", "failed", "errored"]
    healthScore: int
    summary: str
    errorClass: Literal["app_bug", "flaky", "env", "auth"] | None = None


# ─── /resolve ────────────────────────────────────────────────────────────────


class ResolveRequest(BaseModel):
    cdpUrl: str
    selectors: HardenedSelectors


class ResolveResultFound(BaseModel):
    found: Literal[True] = True
    backendNodeId: int
    via: SelectorResolvedVia


class ResolveResultMissing(BaseModel):
    found: Literal[False] = False
    reason: Literal["no_match", "multiple_matches", "page_not_settled"]


# ─── /healthz ────────────────────────────────────────────────────────────────


class HealthResponse(BaseModel):
    ok: bool
    version: str
    browserUseAvailable: bool
    openaiAvailable: bool
