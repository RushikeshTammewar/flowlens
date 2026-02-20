"""Generate a human-readable scan report from crawl results."""

from __future__ import annotations
from agent.models.types import CrawlResult, BugFinding
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.text import Text


SEVERITY_COLORS = {"P0": "red bold", "P1": "red", "P2": "yellow", "P3": "cyan", "P4": "dim"}
CONFIDENCE_ICONS = {"HIGH": "●", "MEDIUM": "◐", "LOW": "○"}


def print_report(result: CrawlResult):
    """Print a beautiful CLI report using Rich."""
    console = Console()

    duration = ""
    if result.started_at and result.completed_at:
        secs = (result.completed_at - result.started_at).total_seconds()
        duration = f" in {secs:.1f}s"

    # Header
    score_color = "green" if result.health_score >= 80 else "yellow" if result.health_score >= 60 else "red"
    header = Text()
    header.append("\n FlowLens Scan Report\n", style="bold")
    header.append(f" {result.url}\n", style="dim")
    header.append(f" {result.pages_tested} pages tested{duration}\n", style="dim")
    console.print(Panel(header, border_style="blue"))

    # Health Score
    console.print()
    score_text = Text()
    score_text.append(f"  Health Score: ", style="bold")
    score_text.append(f"{result.health_score}/100", style=f"bold {score_color}")
    console.print(score_text)
    console.print()

    if not result.bugs:
        console.print("  [green bold]No bugs found! Your site is looking healthy.[/green bold]\n")
        return

    # Bug Summary
    by_severity = {}
    for bug in result.bugs:
        sev = bug.severity.value
        by_severity.setdefault(sev, []).append(bug)

    summary_parts = []
    for sev in ["P0", "P1", "P2", "P3", "P4"]:
        if sev in by_severity:
            color = SEVERITY_COLORS[sev]
            summary_parts.append(f"[{color}]{len(by_severity[sev])} {sev}[/{color}]")
    console.print(f"  Bugs found: {', '.join(summary_parts)}\n")

    # Bug Table
    table = Table(show_header=True, header_style="bold", padding=(0, 1))
    table.add_column("Sev", width=4, justify="center")
    table.add_column("Conf", width=4, justify="center")
    table.add_column("Bug", min_width=40)
    table.add_column("Page", max_width=35)
    table.add_column("View", width=8)

    for bug in sorted(result.bugs, key=lambda b: b.severity.value):
        sev_style = SEVERITY_COLORS.get(bug.severity.value, "white")
        conf_icon = CONFIDENCE_ICONS.get(bug.confidence.value, "?")
        page_short = bug.page_url.replace("https://", "").replace("http://", "")
        if len(page_short) > 35:
            page_short = page_short[:32] + "..."

        table.add_row(
            Text(bug.severity.value, style=sev_style),
            conf_icon,
            bug.title[:60],
            page_short,
            bug.viewport,
        )

    console.print(table)
    console.print()

    # Performance summary
    if result.metrics:
        perf_table = Table(title="Performance", show_header=True, header_style="bold", padding=(0, 1))
        perf_table.add_column("Page", max_width=40)
        perf_table.add_column("Viewport", width=8)
        perf_table.add_column("Load", width=8, justify="right")
        perf_table.add_column("FCP", width=8, justify="right")
        perf_table.add_column("DOM Nodes", width=10, justify="right")

        for m in result.metrics[:20]:
            page_short = m.url.replace("https://", "").replace("http://", "")
            if len(page_short) > 40:
                page_short = page_short[:37] + "..."

            load_style = "green" if m.load_time_ms < 3000 else "yellow" if m.load_time_ms < 5000 else "red"
            load_str = f"[{load_style}]{m.load_time_ms}ms[/{load_style}]"
            fcp_str = f"{m.fcp_ms}ms" if m.fcp_ms else "—"

            perf_table.add_row(page_short, m.viewport, load_str, fcp_str, str(m.dom_node_count))

        console.print(perf_table)
        console.print()

    # Errors
    if result.errors:
        console.print(f"  [dim]Crawl warnings: {len(result.errors)}[/dim]")
        for err in result.errors[:5]:
            console.print(f"    [dim]• {err[:120]}[/dim]")
        console.print()

    console.print("  [dim]Powered by FlowLens — flowlens.in[/dim]\n")
