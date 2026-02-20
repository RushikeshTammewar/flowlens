"""Tier 2 detector: page load times, Web Vitals, resource size."""

from __future__ import annotations
from agent.models.types import BugFinding, PageMetrics, Severity, Category, Confidence


class PerformanceDetector:

    THRESHOLDS = {
        "load_time_ms": {"warning": 3000, "critical": 5000},
        "fcp_ms": {"warning": 1800, "critical": 3000},
        "dom_node_count": {"warning": 1500, "critical": 3000},
    }

    async def collect_metrics(self, page, viewport: str) -> PageMetrics:
        """Collect performance metrics from the current page."""
        timing = await page.evaluate("""() => {
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
                transfer_bytes: nav.transferSize || 0,
            };
        }""")

        if not timing:
            return PageMetrics(url=page.url, viewport=viewport)

        return PageMetrics(
            url=page.url,
            viewport=viewport,
            load_time_ms=timing.get("load_time_ms", 0),
            ttfb_ms=timing.get("ttfb_ms", 0),
            fcp_ms=timing.get("fcp_ms"),
            dom_node_count=timing.get("dom_node_count", 0),
            transfer_bytes=timing.get("transfer_bytes", 0),
        )

    async def detect(self, page, page_url: str, metrics: PageMetrics) -> list[BugFinding]:
        """Check performance metrics against thresholds."""
        findings = []

        checks = [
            ("load_time_ms", metrics.load_time_ms, "Page load time"),
            ("fcp_ms", metrics.fcp_ms, "First Contentful Paint"),
            ("dom_node_count", metrics.dom_node_count, "DOM node count"),
        ]

        for metric_name, value, label in checks:
            if value is None or value == 0:
                continue
            thresholds = self.THRESHOLDS[metric_name]

            unit = "ms" if "ms" in metric_name else "nodes"

            if value > thresholds["critical"]:
                findings.append(BugFinding(
                    title=f"Critical: {label} is {value}{unit}",
                    category=Category.PERFORMANCE,
                    severity=Severity.P1,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    description=f"{label}: {value}{unit} exceeds critical threshold of {thresholds['critical']}{unit}",
                    evidence={"metric": metric_name, "value": value, "threshold": thresholds["critical"]},
                ))
            elif value > thresholds["warning"]:
                findings.append(BugFinding(
                    title=f"Slow: {label} is {value}{unit}",
                    category=Category.PERFORMANCE,
                    severity=Severity.P2,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    description=f"{label}: {value}{unit} exceeds warning threshold of {thresholds['warning']}{unit}",
                    evidence={"metric": metric_name, "value": value, "threshold": thresholds["warning"]},
                ))

        return findings
