# FlowLens — North Star

> AI QA Engineer-as-a-Service. Give it a URL. It tests every user flow like a senior QA engineer would.

## The Vision

FlowLens is a continuous website monitoring service that autonomously discovers and tests user flows on any website. It works like a tireless QA team member who tests your site 24/7, reports bugs, and tracks regressions over time.

**One-liner:** "We check your site every day so you don't have to."

## Core Principles

1. **Behave like a senior QA engineer, not a link checker.** Navigate flows. Fill forms. Test login. Click CTAs. Verify outcomes. Try to break things.
2. **Heuristic-first, AI-assisted.** 80% of value comes from deterministic checks (JS errors, HTTP failures, broken images, Web Vitals). AI adds the remaining 20% (smart navigation, form intelligence, visual verification).
3. **Zero config.** Works with just a URL. Auth credentials are requested interactively only when a login screen is encountered.
4. **Honest about limitations.** Tier 1 bugs (deterministic) are facts. Tier 2 (threshold) are likely. Tier 3 (AI) are suggestions. Never mix them.

## Architecture (4 Phases)

```
Phase A: Discovery          Phase B: Flow ID           Phase C: Flow Execution      Phase D: Bug Detection
─────────────────          ─────────────              ─────────────────────        ──────────────────────
Playwright BFS crawl   →   Gemini Flash identifies →  Step-by-step execution  →   Passive listeners during
builds SiteGraph            5-8 user flows             with verification            all navigation
(zero AI)                   (1 LLM call, cached)       (heuristic + AI fallback)    (JS errors, HTTP, perf)
```

## Target Users

- **Startup CTOs** (10-50 engineers, no QA team): "Did someone break checkout last night?"
- **E-commerce businesses**: Revenue is tied to site working. Daily monitoring catches issues before customers do.
- **Agencies managing client sites**: Monitor 10+ sites from one dashboard.

## What Makes FlowLens Different

- **Autonomous flow discovery.** No scripting. No test authoring. Just a URL.
- **Continuous monitoring.** Not a one-time scan -- daily crawls with historical intelligence.
- **Flow-based testing.** Tests complete user journeys (search → product → cart → checkout), not just individual pages.
- **Interactive auth.** When a login screen is detected, prompts the user for credentials in real-time. Gets past auth walls.
- **Cost-efficient.** ~$0.05-0.10 per scan using Gemini 2.0 Flash. 95%+ heuristic, 5% AI.

## The Product Over Time

**Now (v0.2):** CLI + API scanner. Discovers pages, identifies flows, executes them, reports bugs. Login support via interactive prompt. Deployed at flowlens.in.

**Next (v0.3):** Conditional flow logic, state tracking across steps, negative testing, smart waiting. Robust enough to test 10 diverse real websites reliably.

**Future (v1.0):** Multi-tenant SaaS with dashboard, daily scheduled crawls, email briefings, historical trends, deploy correlation via CI/CD webhooks, Slack/email alerts, bug lifecycle tracking.

## Tech Stack

- **Agent:** Python 3.14 + Playwright + Gemini 2.0 Flash
- **Backend:** FastAPI with SSE streaming
- **Frontend:** Next.js + Tailwind (Vercel)
- **Infrastructure:** EC2 (ap-south-1) + Nginx + SSL
- **Domain:** flowlens.in (GoDaddy)

## Success Metrics

- 8/10 real websites: flows identified and executed correctly
- 7/10: at least 1 flow passes end-to-end
- 10/10: no crashes, graceful auth-wall and CAPTCHA handling
- < 3 minutes per scan, < $0.10 AI cost per scan
- Login flows work when user provides credentials
