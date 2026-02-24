"""Flow execution context -- state tracked across all steps in a flow.

FlowContext persists variables, snapshots, and metadata throughout
the execution of a single flow, enabling cross-step assertions
and state-aware verification.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.utils.state_verifier import StateSnapshot, StateChange


@dataclass
class FlowContext:
    """Mutable state maintained throughout a flow's execution."""

    variables: dict[str, Any] = field(default_factory=dict)
    navigation_history: list[str] = field(default_factory=list)
    state_snapshots: list[StateSnapshot] = field(default_factory=list)
    state_changes: list[StateChange] = field(default_factory=list)
    console_errors_total: list[str] = field(default_factory=list)
    network_errors_total: list[dict] = field(default_factory=list)
    steps_completed: int = 0
    steps_failed: int = 0
    auth_completed: bool = False
    site_type: str = "generic"
    search_query_used: str = ""

    def set(self, key: str, value: Any):
        self.variables[key] = value

    def get(self, key: str, default: Any = None) -> Any:
        return self.variables.get(key, default)

    def record_navigation(self, url: str):
        self.navigation_history.append(url)

    def record_snapshot(self, snapshot: StateSnapshot):
        self.state_snapshots.append(snapshot)

    def record_state_change(self, change: StateChange):
        self.state_changes.append(change)
        self.console_errors_total.extend(change.new_console_errors)
        self.network_errors_total.extend(change.new_network_errors)

    @property
    def total_errors(self) -> int:
        return len(self.console_errors_total) + len(self.network_errors_total)

    def summary(self) -> dict:
        return {
            "steps_completed": self.steps_completed,
            "steps_failed": self.steps_failed,
            "pages_visited": len(self.navigation_history),
            "total_js_errors": len(self.console_errors_total),
            "total_network_errors": len(self.network_errors_total),
            "auth_completed": self.auth_completed,
            "site_type": self.site_type,
        }
