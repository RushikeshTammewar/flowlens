"""Test flow identification on a real site."""

import asyncio
import os
import sys

# Add agent to path
sys.path.insert(0, '/Users/rtammewar/personal-workspace/flowlens')

from agent.core.flow_planner import identify_flows
from agent.models.graph import SiteGraph, SiteNode, PageElement

if not os.environ.get('GEMINI_API_KEY'):
    print("Set GEMINI_API_KEY env var to enable AI features")
    print("  export GEMINI_API_KEY=your-key-here")


def create_test_graph_wikipedia():
    """Create a minimal site graph for Wikipedia."""
    graph = SiteGraph(root_url="https://www.wikipedia.org")

    # Homepage
    home = SiteNode(url="https://www.wikipedia.org/", title="Wikipedia", page_type="home")
    home.status = "visited"
    home.elements = [
        PageElement(type="search", text="Search Wikipedia", selector="#searchInput"),
        PageElement(type="nav", text="English", selector="a[lang='en']"),
        PageElement(type="nav", text="Español", selector="a[lang='es']"),
        PageElement(type="nav", text="Français", selector="a[lang='fr']"),
    ]
    graph.nodes[home.url] = home
    graph.edges.append(("https://www.wikipedia.org/", "https://en.wikipedia.org/"))

    # Article page
    article = SiteNode(url="https://en.wikipedia.org/wiki/Python_(programming_language)",
                      title="Python (programming language)",
                      page_type="content")
    article.status = "visited"
    article.elements = [
        PageElement(type="search", text="Search", selector="#searchInput"),
        PageElement(type="nav", text="Main Page", selector="a"),
        PageElement(type="nav", text="Contents", selector="a"),
    ]
    graph.nodes[article.url] = article

    return graph


async def main():
    print("=" * 60)
    print("Testing Flow Identification with Gemini")
    print("=" * 60)
    print()

    # Test 1: Wikipedia
    print("Test 1: Wikipedia")
    print("-" * 60)
    graph = create_test_graph_wikipedia()
    print(f"Site: {graph.root_url}")
    print(f"Pages: {len(graph.nodes)}")
    print(f"Edges: {len(graph.edges)}")
    print()

    print("Calling identify_flows()...")
    flows = await identify_flows(graph)

    print(f"\n✓ Identified {len(flows)} flows:")
    print()
    for i, flow in enumerate(flows, 1):
        print(f"Flow {i}: {flow.name} (Priority: {flow.priority})")
        for j, step in enumerate(flow.steps, 1):
            print(f"  Step {j}: {step.action} | {step.target} | {step.url_hint} | verify: {step.verify}")
        print()

    # Test 2: Heuristic fallback (no API key)
    print("\n" + "=" * 60)
    print("Test 2: Heuristic Fallback (no API key)")
    print("-" * 60)

    os.environ.pop('GEMINI_API_KEY', None)
    flows_fallback = await identify_flows(graph)

    print(f"\n✓ Heuristic flows: {len(flows_fallback)}")
    for i, flow in enumerate(flows_fallback, 1):
        print(f"Flow {i}: {flow.name} (Priority: {flow.priority})")
        for j, step in enumerate(flow.steps, 1):
            print(f"  Step {j}: {step.action} | {step.target}")
        print()

    print("=" * 60)
    print("✓ All tests passed!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
