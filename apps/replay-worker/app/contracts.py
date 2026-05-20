"""Request / response contracts shared with the TS caller.

Field names MUST match `packages/replay-engine/src/types.ts` exactly so the
Pydantic models on this side and the Zod schemas on the TS side can share a
serialization. We do not use `aliasing` — keep the camelCase names on the wire.

Phase 4 / Tier 3 (LLD §6.4 + §8) adds three optional add-ons on top of the
existing V1 contract — assertion specs, structured session state, and the
post-replay AssertionEval. All Phase 4 fields are nullable / default-empty
so legacy callers (Phase 3 single-runs, the extension's pre-flag matrix
endpoint) keep working unchanged.
"""
from __future__ import annotations

from typing import Any, Literal

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


class CookieParam(BaseModel):
    """Mirror of @flowlens/schema ChromeCookie. We accept the extension shape
    verbatim and convert to CDP `Storage.setCookies` params at injection time.

    The `expires` field is the Unix epoch seconds (float) per the Chrome
    extension API. CDP wants the same — pass through unchanged.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    name: str
    value: str
    domain: str
    path: str = "/"
    expires: float | None = None
    httpOnly: bool = False
    secure: bool = False
    # ChromeCookie carries 'unspecified'; CDP rejects that. We sanitize at use.
    sameSite: Literal["Strict", "Lax", "None", "unspecified"] = "unspecified"


class StorageItem(BaseModel):
    """One {key, value} entry from a captured Web Storage area.

    Mirrors `Storage.{local,session}Storage` snapshot shape from the
    extension. Phase 4 / Tier 3 — see `state_replicate.py`.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    key: str
    value: str


class FingerprintHints(BaseModel):
    """Browser fingerprint hints injected via CDP `Emulation.*` before the
    first navigation. Phase 4 / Tier 3 — keeps the cloud browser visually
    indistinguishable from the recorder's environment for sites that
    branch on UA / locale / timezone (e.g. localized validation copy).

    All fields optional — only the populated ones get applied.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    userAgent: str | None = None
    viewportWidth: int | None = None
    viewportHeight: int | None = None
    deviceScaleFactor: float | None = None
    timezoneId: str | None = None
    locale: str | None = None


class SessionState(BaseModel):
    """Phase 4 / Tier 3 — the additive session-replication payload that
    rides alongside `cookies`. Each layer is optional.

    Cookies are carried on `RunRequest.cookies` (V1 — already plumbed).
    The fields here cover what `state_replicate.py` injects ON TOP of
    cookies before the first navigation:

      - localStorage / sessionStorage: per-origin {key:value} sets
        captured by the recorder. Injected via CDP `Runtime.evaluate`
        right after the landing-URL navigate, scoped by document.
      - fingerprint: UA / viewport / locale / timezone hints applied
        via `Emulation.setUserAgentOverride`,
        `Emulation.setDeviceMetricsOverride`,
        `Emulation.setLocaleOverride`,
        `Emulation.setTimezoneOverride`.

    IndexedDB and Service-Worker registrations are deferred (LLD §8.x
    notes — captured but not yet replayed). Permissions are also
    deferred.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    localStorage: dict[str, list[StorageItem]] = Field(default_factory=dict)
    sessionStorage: dict[str, list[StorageItem]] = Field(default_factory=dict)
    fingerprint: FingerprintHints | None = None


# ─── Phase 4 / Tier 3 — Assertion engine ─────────────────────────────────────


AssertionKind = Literal[
    "url_matches",
    "dom_text_present",
    "dom_text_absent",
    "dom_count",
    "row_content_match",
    "console_no_errors",
    "no_network_5xx",
    "page_load_no_crash",
    "screenshot_judge",
]


class AssertionSpec(BaseModel):
    """Loose-typed mirror of `packages/schema/src/assertion.ts`'s
    discriminated union. We keep it loose on purpose: the Python side
    only needs to switch on `kind` and pull payload keys per handler;
    enforcing the union here would mean keeping two source-of-truth
    schemas in lockstep across language boundaries for no benefit.

    The TS side validates the Zod schema before sending; we trust the
    payload here and surface a deterministic-handler-unavailable
    fallback if a key is missing at evaluation time.
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    kind: AssertionKind


class Assertion(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    spec: AssertionSpec
    fallbackPrompt: str


class AssertionEval(BaseModel):
    """Result emitted by `assertion_engine.evaluate()`. Persisted to
    `step_results.assertion_eval` jsonb on the variant's last step (the
    aggregator reads from there + `runs.status` to roll up to the
    two-axis verdict).
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    passed: bool
    evaluatedKind: AssertionKind
    reason: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    evaluatedAt: str
    durationMs: int = 0
    llmFallbackUsed: bool = False


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
    # Cookies to inject into the BU Cloud session BEFORE the first navigation.
    # Decrypted by the caller from `cookie_snapshots` and forwarded for the
    # life of this run only — never persisted on the worker.
    cookies: list[CookieParam] = Field(default_factory=list)
    # Optional landing URL — if provided, the worker navigates here AFTER
    # cookies are set so the very first page-load already carries them.
    # Defaults to flow.siteOrigin.
    landingUrl: str | None = None
    # ── Phase 4 / Tier 3 (all optional, V1 callers omit) ───────────────
    # The variant-level assertion to evaluate after the step loop ends.
    # When None, the sidecar falls back to V1 step-level judge behavior.
    assertion: Assertion | None = None
    # Whether `assertion.passed=True` means "the variant succeeded as
    # designed". For adversarial-mode variants the test passes when the
    # app REJECTS the input — `shouldPass=False` flips the polarity at
    # run aggregation time. The sidecar reports the raw assertion eval
    # and lets the web aggregator apply polarity (single source of truth).
    shouldPass: bool = True
    # Soft FK to flow.featureContract.expectedBehaviors[].id — echoed
    # back on RunCompleteEvent so the aggregator doesn't need a second
    # DB roundtrip per run. None for invariant-mode variants.
    behaviorId: str | None = None
    # Variant testing mode — informational; only affects logging and
    # aggregator polarity. Defaults to verify so legacy callers behave
    # like Phase 3 happy-path.
    mode_phase4: Literal["verify", "edge", "stress", "adversarial", "invariant"] | None = (
        Field(default=None, alias="phase4Mode")
    )
    # Optional structural-divergence task description — when present
    # AND the per-step `simple_replay` cannot satisfy the variant
    # (because it requires actions outside the recorded steps, e.g.
    # "click the Reset button"), the sidecar dispatches the
    # browser_use.Agent loop instead of stepwise replay. Compatible
    # with the existing `mode: full_llm` path — Phase 4 callers can
    # skip this field and rely on simple_replay.
    structuralTask: str | None = None
    # Phase 4 / Tier 3 — additive session-replication state on top of
    # cookies. Empty default keeps V1 callers identical to today.
    state: SessionState = Field(default_factory=SessionState)


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
    # Raw base64 PNG of the post-step viewport. The TS caller decodes
    # this, uploads to Vercel Blob, and stamps `replayScreenshotBlobKey`
    # before persisting the step row — keeping blob credentials on the
    # web side so the worker stays env-var-free.
    replayScreenshotPngB64: str | None = None
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
    # Phase 4 / Tier 3 — only populated when RunRequest carried an
    # `assertion`. Aggregator pulls this off the run_complete event and
    # writes to step_results.assertion_eval (last step) so the web
    # report can render "passed because: <evidence>" / "failed because:
    # <reason>". `None` for V1 / Phase 3 callers.
    assertionEval: AssertionEval | None = None
    # Echoed from the request so the aggregator doesn't re-query the
    # variant row. None when the run wasn't carrying a Phase 4 spec.
    behaviorId: str | None = None
    phase4Mode: Literal["verify", "edge", "stress", "adversarial", "invariant"] | None = None


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
