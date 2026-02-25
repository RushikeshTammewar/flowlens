"""Flow-based QA data structures.

Flow, FlowStep, FlowResult, FlowStepResult, and ConditionalStep
represent user journeys identified by the flow planner and executed
by the flow runner.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FlowStep:
    """A single step in a user flow."""

    action: str   # navigate | click | fill_form | search | verify | conditional
    target: str   # what to interact with ("search box", "Add to Cart button")
    url_hint: str = ""   # expected URL pattern ("/products/*", "/cart")
    verify: str = ""     # what to check ("results appear", "redirected to dashboard")

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "target": self.target,
            "url_hint": self.url_hint,
            "verify": self.verify,
        }


@dataclass
class ConditionalStep:
    """A flow step that branches based on a page condition.

    condition_js is evaluated in the browser. If truthy, then_step executes;
    otherwise else_step (if provided) or the step is skipped.
    """
    condition: str          # human-readable: "if cookie banner visible"
    condition_js: str       # JS expression: "!!document.querySelector('[class*=cookie]')"
    then_step: FlowStep
    else_step: FlowStep | None = None

    def to_dict(self) -> dict:
        d = {
            "condition": self.condition,
            "then_step": self.then_step.to_dict(),
        }
        if self.else_step:
            d["else_step"] = self.else_step.to_dict()
        return d


@dataclass
class Flow:
    """A user journey to test (e.g. Search, Login, Checkout)."""

    name: str
    priority: int   # 1 = critical, 5 = low
    steps: list[FlowStep | ConditionalStep] = field(default_factory=list)
    requires: list[str] = field(default_factory=list)  # flow dependencies: ["login"]

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "priority": self.priority,
            "steps": [s.to_dict() for s in self.steps],
            "requires": self.requires,
        }


@dataclass
class FlowStepResult:
    """Result of executing a single flow step."""

    step: FlowStep
    status: str   # passed | failed | blocked | inconclusive | skipped
    actual_url: str = ""
    screenshot_b64: str | None = None
    error: str | None = None
    ai_used: str | bool = "Heuristic"
    state_changes: dict | None = None

    def to_dict(self) -> dict:
        ai_method = self.ai_used
        if isinstance(ai_method, bool):
            ai_method = "AI-assisted" if ai_method else "Heuristic"

        return {
            "step": self.step.to_dict(),
            "status": self.status,
            "actual_url": self.actual_url,
            "screenshot_b64": self.screenshot_b64,
            "error": self.error,
            "ai_used": ai_method,
            "state_changes": self.state_changes,
        }


@dataclass
class FlowResult:
    """Result of executing an entire flow."""

    flow: Flow
    status: str   # passed | failed | blocked | partial
    steps: list[FlowStepResult] = field(default_factory=list)
    duration_ms: int = 0
    context_summary: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "flow": self.flow.to_dict(),
            "status": self.status,
            "steps": [s.to_dict() for s in self.steps],
            "duration_ms": self.duration_ms,
            "context_summary": self.context_summary,
        }
