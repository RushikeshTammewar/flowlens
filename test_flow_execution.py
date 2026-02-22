"""Test end-to-end flow execution with verification."""

import asyncio
import os
import sys

sys.path.insert(0, '/Users/rtammewar/personal-workspace/flowlens')

from agent.core.scanner import FlowLensScanner

# Set API key
os.environ['GEMINI_API_KEY'] = 'AIzaSyAAVmOZKgAAf2dqfATPq1261awK-Wt940I'


async def test_wikipedia():
    """Test flow-based QA on Wikipedia."""
    print("=" * 70)
    print("TESTING: FlowLens Flow-Based QA on Wikipedia")
    print("=" * 70)
    print()

    scanner = FlowLensScanner(url="https://www.wikipedia.org", max_pages=5)

    print("Starting scan...")
    result = await scanner.scan()

    print("\n" + "=" * 70)
    print("SCAN COMPLETE")
    print("=" * 70)
    print(f"Pages explored: {result.pages_explored}")
    print(f"Pages discovered: {result.pages_discovered}")
    print(f"Bugs found: {len(result.bugs)}")
    print(f"Flows tested: {len(result.flows) if result.flows else 0}")
    print()

    if result.flows:
        print("FLOW RESULTS:")
        print("-" * 70)
        for i, flow_result in enumerate(result.flows, 1):
            flow = flow_result.flow
            status_icon = "✓" if flow_result.status == "passed" else "✗"
            print(f"\n{status_icon} Flow {i}: {flow.name} (Priority: {flow.priority})")
            print(f"   Status: {flow_result.status.upper()}")
            print(f"   Duration: {flow_result.duration_ms}ms")
            print(f"   Steps: {len(flow_result.steps)}/{len(flow.steps)}")
            print()

            for j, step_result in enumerate(flow_result.steps, 1):
                step = step_result.step
                step_icon = "✓" if step_result.status == "passed" else "✗"
                print(f"     {step_icon} Step {j}: {step.action} '{step.target}'")
                print(f"        URL: {step_result.actual_url}")
                print(f"        Status: {step_result.status}")
                print(f"        Method: {step_result.ai_used}")
                if step_result.error:
                    print(f"        Result: {step_result.error}")
                print()
    else:
        print("❌ No flows were identified or executed")

    print("\nBUGS FOUND:")
    print("-" * 70)
    if result.bugs:
        for bug in result.bugs[:5]:  # Show first 5
            print(f"  • [{bug.severity}] {bug.title}")
            print(f"    {bug.page_url}")
            print()
    else:
        print("  No bugs found - site looks healthy!")

    print("=" * 70)
    return result


async def main():
    try:
        result = await test_wikipedia()
        print(f"\n✓ Test completed successfully")
        print(f"  - Flows identified: {len(result.flows) if result.flows else 0}")
        print(f"  - Flows passed: {sum(1 for f in (result.flows or []) if f.status == 'passed')}")
        print(f"  - Bugs found: {len(result.bugs)}")

    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
