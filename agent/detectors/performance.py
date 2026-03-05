"""Tier 2 detector: page load times, Web Vitals, resource size.

v2: uses execute_javascript (CDP) instead of Playwright page.evaluate.
"""

from __future__ import annotations

from typing import Any, Callable, Awaitable

from agent.models.types import BugFinding, PageMetrics, Severity, Category, Confidence

ExecuteJS = Callable[[str], Awaitable[Any]]

_PERF_METRICS = """(() => {
    const entries = performance.getEntriesByType('navigation');
    if (!entries.length) return null;
    const nav = entries[0];
    const paint = performance.getEntriesByType('paint');
    const fcp = paint.find(p => p.name === 'first-contentful-paint');
    return {
        load_time_ms: Math.round(nav.loadEventEnd - nav.startTime),
        ttfb_ms: Math.round(nav.responseStart - nav.requestStart),
        fcp_ms: fcp ? Math.round(fcp.startTime) : null,
        dom_node_count: document.querySelectorAll('*').length,
        transfer_bytes: nav.transferSize || 0
    };
})()"""


class PerformanceDetector:

    THRESHOLDS = {
        "load_time_ms": {"warning": 3000, "critical": 5000},
        "fcp_ms": {"warning": 1800, "critical": 3000},
        "dom_node_count": {"warning": 1500, "critical": 3000},
    }

    async def collect_metrics(self, execute_js: ExecuteJS, url: str, viewport: str) -> PageMetrics:
        timing = await execute_js(_PERF_METRICS)
        if not timing or not isinstance(timing, dict):
            return PageMetrics(url=url, viewport=viewport)

        return PageMetrics(
            url=url,
            viewport=viewport,
            load_time_ms=timing.get("load_time_ms", 0),
            ttfb_ms=timing.get("ttfb_ms", 0),
            fcp_ms=timing.get("fcp_ms"),
            dom_node_count=timing.get("dom_node_count", 0),
            transfer_bytes=timing.get("transfer_bytes", 0),
        )

    async def detect(self, execute_js: ExecuteJS, page_url: str, metrics: PageMetrics) -> list[BugFinding]:
        findings: list[BugFinding] = []

        checks = [
            ("load_time_ms", metrics.load_time_ms, "Page load time"),
            ("fcp_ms", metrics.fcp_ms, "First Contentful Paint"),
            ("dom_node_count", metrics.dom_node_count, "DOM node count"),
        ]

        for metric_name, value, label in checks:
            if value is None or value == 0:
                continue
            t = self.THRESHOLDS[metric_name]
            unit = "ms" if "ms" in metric_name else "nodes"

            if value > t["critical"]:
                findings.append(BugFinding(
                    title=f"Critical: {label} is {value}{unit}",
                    category=Category.PERFORMANCE,
                    severity=Severity.P1,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    description=f"{label}: {value}{unit} exceeds critical threshold of {t['critical']}{unit}",
                    evidence={"metric": metric_name, "value": value, "threshold": t["critical"]},
                ))
            elif value > t["warning"]:
                findings.append(BugFinding(
                    title=f"Slow: {label} is {value}{unit}",
                    category=Category.PERFORMANCE,
                    severity=Severity.P2,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    description=f"{label}: {value}{unit} exceeds warning threshold of {t['warning']}{unit}",
                    evidence={"metric": metric_name, "value": value, "threshold": t["warning"]},
                ))

        return findings
