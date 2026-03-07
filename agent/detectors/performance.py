"""Performance detector: page load times, Core Web Vitals, resource analysis.

Checks: Load time, TTFB, FCP, LCP, CLS, DOM size, transfer size.
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

    let lcp_ms = null;
    try {
        const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
        if (lcpEntries.length > 0) lcp_ms = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
    } catch {}

    let cls = null;
    try {
        const layoutShifts = performance.getEntriesByType('layout-shift');
        if (layoutShifts.length > 0) {
            cls = 0;
            let sessionScore = 0, sessionMax = 0, prevEnd = 0;
            for (const entry of layoutShifts) {
                if (!entry.hadRecentInput) {
                    if (entry.startTime - prevEnd > 1000 || entry.startTime - prevEnd > 5000) {
                        sessionMax = Math.max(sessionMax, sessionScore);
                        sessionScore = entry.value;
                    } else {
                        sessionScore += entry.value;
                    }
                    prevEnd = entry.startTime + entry.duration;
                }
            }
            cls = Math.round(Math.max(sessionMax, sessionScore) * 1000) / 1000;
        }
    } catch {}

    const resources = performance.getEntriesByType('resource');
    const resourceCount = resources.length;

    return {
        load_time_ms: Math.round(nav.loadEventEnd - nav.startTime),
        ttfb_ms: Math.round(nav.responseStart - nav.requestStart),
        fcp_ms: fcp ? Math.round(fcp.startTime) : null,
        lcp_ms: lcp_ms,
        cls: cls,
        dom_node_count: document.querySelectorAll('*').length,
        transfer_bytes: nav.transferSize || 0,
        request_count: resourceCount
    };
})()"""


class PerformanceDetector:

    THRESHOLDS = {
        "load_time_ms": {"warning": 3000, "critical": 5000},
        "ttfb_ms": {"warning": 800, "critical": 1800},
        "fcp_ms": {"warning": 1800, "critical": 3000},
        "lcp_ms": {"warning": 2500, "critical": 4000},
        "cls": {"warning": 0.1, "critical": 0.25},
        "dom_node_count": {"warning": 1500, "critical": 3000},
        "transfer_bytes": {"warning": 3_000_000, "critical": 8_000_000},
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
            request_count=timing.get("request_count", 0),
        )

    async def detect(self, execute_js: ExecuteJS, page_url: str, metrics: PageMetrics) -> list[BugFinding]:
        findings: list[BugFinding] = []

        timing = await execute_js(_PERF_METRICS)
        if not timing or not isinstance(timing, dict):
            return findings

        checks = [
            ("load_time_ms", metrics.load_time_ms, "Page load time", "ms"),
            ("ttfb_ms", metrics.ttfb_ms, "Time to First Byte", "ms"),
            ("fcp_ms", metrics.fcp_ms, "First Contentful Paint", "ms"),
            ("lcp_ms", timing.get("lcp_ms"), "Largest Contentful Paint", "ms"),
            ("cls", timing.get("cls"), "Cumulative Layout Shift", ""),
            ("dom_node_count", metrics.dom_node_count, "DOM node count", " nodes"),
            ("transfer_bytes", metrics.transfer_bytes, "Page transfer size", " bytes"),
        ]

        for metric_name, value, label, unit in checks:
            if value is None or value == 0:
                continue
            t = self.THRESHOLDS.get(metric_name)
            if not t:
                continue

            display_val = f"{value:,.0f}{unit}" if isinstance(value, (int, float)) and unit != "" else str(value)
            if unit == " bytes" and isinstance(value, (int, float)):
                display_val = f"{value / 1_000_000:.1f}MB"

            if value > t["critical"]:
                findings.append(BugFinding(
                    title=f"Critical: {label} is {display_val}",
                    category=Category.PERFORMANCE,
                    severity=Severity.P1,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    description=f"{label}: {display_val} exceeds critical threshold ({t['critical']}{unit})",
                    evidence={"metric": metric_name, "value": value, "threshold": t["critical"]},
                ))
            elif value > t["warning"]:
                findings.append(BugFinding(
                    title=f"Slow: {label} is {display_val}",
                    category=Category.PERFORMANCE,
                    severity=Severity.P2,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    description=f"{label}: {display_val} exceeds warning threshold ({t['warning']}{unit})",
                    evidence={"metric": metric_name, "value": value, "threshold": t["warning"]},
                ))

        return findings
