"""Graph data structures for the site explorer.

SiteGraph is the core data structure that the explorer builds as it
navigates a website. Every visited page becomes a SiteNode containing
the interactive elements found on that page and the actions taken.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from agent.models.types import BugFinding, PageMetrics


@dataclass
class PageElement:
    """An interactive element discovered on a page."""

    type: str          # nav_link | content_link | button | form | search | dropdown | cta | footer_link | sidebar_link
    selector: str      # CSS selector to locate this element
    text: str          # visible text content
    href: str | None = None
    priority: int = 5  # 1 (lowest) to 10 (highest)

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "selector": self.selector,
            "text": self.text,
            "href": self.href,
            "priority": self.priority,
        }


@dataclass
class ActionResult:
    """The outcome of interacting with a page element."""

    action_type: str     # click | fill_form | expand_menu | search | hover
    target: str          # description of what element we acted on
    outcome: str         # navigated | popup | error | no_change | new_content
    new_url: str | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "action_type": self.action_type,
            "target": self.target,
            "outcome": self.outcome,
            "new_url": self.new_url,
            "error": self.error,
        }


@dataclass
class SiteNode:
    """A single page in the site graph."""

    url: str
    title: str = ""
    page_type: str = "other"      # home | nav | product | form | login | search | other
    status: str = "discovered"    # discovered | visiting | visited | failed | blocked
    depth: int = 0
    elements: list[PageElement] = field(default_factory=list)
    actions: list[ActionResult] = field(default_factory=list)
    bugs: list[BugFinding] = field(default_factory=list)
    metrics: PageMetrics | None = None
    screenshot_b64: str | None = None

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "title": self.title,
            "page_type": self.page_type,
            "status": self.status,
            "depth": self.depth,
            "element_count": len(self.elements),
            "action_count": len(self.actions),
            "bug_count": len(self.bugs),
            "actions": [a.to_dict() for a in self.actions],
        }


@dataclass
class SiteGraph:
    """The complete graph of a site built during exploration."""

    root_url: str
    nodes: dict[str, SiteNode] = field(default_factory=dict)
    edges: list[tuple[str, str]] = field(default_factory=list)

    def add_node(self, url: str, **kwargs) -> SiteNode:
        if url not in self.nodes:
            self.nodes[url] = SiteNode(url=url, **kwargs)
        return self.nodes[url]

    def add_edge(self, from_url: str, to_url: str):
        edge = (from_url, to_url)
        if edge not in self.edges and from_url != to_url:
            self.edges.append(edge)

    def get_node(self, url: str) -> SiteNode | None:
        return self.nodes.get(url)

    def get_unvisited(self) -> list[SiteNode]:
        return [n for n in self.nodes.values() if n.status == "discovered"]

    def to_dict(self) -> dict:
        """Serialize to the format the frontend expects."""
        sev_order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}
        out_nodes = []
        for node in self.nodes.values():
            bug_count = len(node.bugs)
            max_sev = None
            for bug in node.bugs:
                sv = bug.severity.value
                if max_sev is None or sev_order.get(sv, 4) < sev_order.get(max_sev, 4):
                    max_sev = sv

            path_parts = node.url.replace("https://", "").replace("http://", "").split("/", 1)
            path = "/" + (path_parts[1] if len(path_parts) > 1 else "")

            out_nodes.append({
                "id": node.url,
                "label": node.title or path.split("/")[-1] or "/",
                "path": path,
                "status": node.status,
                "page_type": node.page_type,
                "bugs": bug_count,
                "max_severity": max_sev,
                "depth": node.depth,
                "element_count": len(node.elements),
                "action_count": len(node.actions),
            })

        out_edges = [{"from": f, "to": t} for f, t in self.edges]
        return {"nodes": out_nodes, "edges": out_edges}


ProgressCallback = Callable[[str, dict], None]
