"""Flow-based QA data structures.

Flow, FlowStep, FlowResult, and FlowStepResult represent user journeys
identified by the flow planner and executed by the flow runner.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class FlowStep:
    """A single step in a user flow."""

    action: str   # navigate | click | fill_form | search | verify
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
class Flow:
    """A user journey to test (e.g. Search, Login, Checkout)."""

    name: str
    priority: int   # 1 = critical, 5 = low
    steps: list[FlowStep] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "priority": self.priority,
            "steps": [s.to_dict() for s in self.steps],
        }


@dataclass
class FlowStepResult:
    """Result of executing a single flow step."""

    step: FlowStep
    status: str   # passed | failed | skipped
    actual_url: str = ""
    screenshot_b64: str | None = None
    error: str | None = None
    ai_used: str | bool = "Heuristic"   # "Heuristic" | "AI verification" | "AI-assisted (element finding)" | bool for backward compat

    def to_dict(self) -> dict:
        # Convert bool to string for consistency
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
        }


@dataclass
class FlowResult:
    """Result of executing an entire flow."""

    flow: Flow
    status: str   # passed | failed | partial
    steps: list[FlowStepResult] = field(default_factory=list)
    duration_ms: int = 0

    def to_dict(self) -> dict:
        return {
            "flow": self.flow.to_dict(),
            "status": self.status,
            "steps": [s.to_dict() for s in self.steps],
            "duration_ms": self.duration_ms,
        }
