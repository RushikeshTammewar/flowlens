"""Smoke tests for `build_agent_task` — the prompt fed to the Agent loop."""
from __future__ import annotations

from app.agent_step import build_agent_task
from app.contracts import Flow, FlowStep, HardenedSelectors


def _flow_with_step(**step_kwargs: object) -> tuple[Flow, FlowStep]:
    step = FlowStep(
        index=2,
        action="click",
        intent="Click the Add to Cart button",
        expectedOutcome="Cart counter increments to 1",
        isCritical=True,
        selectors=HardenedSelectors(testid="add-to-cart", role="button", accessibleName="Add to Cart"),
        recordedScreenshotKey="recordings/abc/screenshots/0002.webp",
        url="https://shop.example.com/products/123",
    )
    flow = Flow(
        id="flow-id",
        name="Add to cart and checkout",
        siteOrigin="https://shop.example.com",
        steps=[step, step.model_copy(update={"index": 0}), step.model_copy(update={"index": 1})],
    )
    _ = step_kwargs
    return flow, step


def test_task_includes_intent_and_expected() -> None:
    flow, step = _flow_with_step()
    task = build_agent_task(step, flow)
    assert "Add to Cart" in task
    assert "Cart counter increments to 1" in task
    assert "step (3 of 3)" in task or "step (3 of " in task


def test_task_includes_selector_block() -> None:
    flow, step = _flow_with_step()
    task = build_agent_task(step, flow)
    assert "testid: add-to-cart" in task
    assert "role: button" in task
    assert "Add to Cart" in task


def test_task_handles_missing_selectors() -> None:
    flow, step = _flow_with_step()
    step.selectors = HardenedSelectors()
    task = build_agent_task(step, flow)
    assert "(no recorded selectors)" in task
