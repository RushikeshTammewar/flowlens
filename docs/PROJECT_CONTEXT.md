# FlowLens — Complete Project Context

> This file contains everything an LLM needs to understand FlowLens end-to-end. Business context, technical architecture, code structure, design decisions, API contracts, data models, deployment, and roadmap.

---

## 1. What Is FlowLens?

FlowLens is an AI-powered QA engineer-as-a-service. Given a website URL, it autonomously:
1. Discovers all pages by navigating a real browser (Playwright)
2. Identifies critical user flows (search, login, checkout, browse) using Gemini AI
3. Executes each flow step-by-step like a human would
4. Detects bugs passively during navigation (JS errors, broken images, slow pages, accessibility issues)
5. Reports results with health score, bug list, flow pass/fail, and screenshots

**Domain:** flowlens.in | **API:** api.flowlens.in | **Repo:** github.com/RushikeshTammewar/flowlens

---

## 2. Business Context

**Market:** $60B+ TAM (QA testing + website monitoring). No competitor sits in the "Continuous Monitoring + Zero Config + Flow Testing" quadrant.

**Competitors:**
- QA.tech: Uses Claude, but positioned as PR review tool. $29-299/mo.
- Flowtest.ai: Requires manual flow definition. No autonomous discovery.
- Momentic.ai: $15M Series A. Test authoring tool, not monitoring.
- Ranger ($8.9M), Spur ($4.5M): Adjacent but different focus.

**Target customers:** Startup CTOs (10-50 engineers, no QA team), e-commerce businesses (revenue = site uptime), agencies managing multiple client sites.

**Pricing vision:** Free scan (1 URL, no auth) → Pro $49/mo (3 sites, daily) → Business $149/mo (10 sites, hourly, Slack alerts).

---

## 3. Technical Architecture

### 4-Phase Pipeline

```
Phase A: Discovery (zero AI)
├── SiteExplorer does BFS with Playwright
├── Clicks links, expands menus, fills forms, tests search
├── Builds SiteGraph (nodes=pages, edges=links)
└── Output: SiteGraph with discovered pages and elements

Phase B: Flow Identification (1 AI call)
├── Send SiteGraph summary to Gemini 2.0 Flash
├── AI identifies 5-8 testable user flows
├── Fallback: heuristic flow generation from graph structure
└── Output: list[Flow] with steps

Phase C: Flow Execution (AI-powered, heuristic fast-path)
├── FlowRunner executes each flow step-by-step
├── AI picks elements to interact with (GeminiEngine.pick_element)
├── AI decides search queries (GeminiEngine.decide_search_query)
├── AI analyzes and fills forms (GeminiEngine.analyze_form)
├── AI verifies every action via screenshot (GeminiEngine.verify_action)
├── AI recovers from failures (GeminiEngine.decide_recovery_action)
├── State tracking: cookies, localStorage, console errors per step
├── Auth handling: detects login screens, prompts user interactively
└── Output: list[FlowResult] with pass/fail, state_changes, context_summary

Phase D: Bug Detection (passive, during all navigation)
├── Functional: JS errors, HTTP 4xx/5xx, broken images, mixed content
├── Performance: load time, FCP, DOM size thresholds
├── Responsive: horizontal overflow, touch targets, font size
├── Accessibility: alt text, labels, lang attribute, page title
└── Output: list[BugFinding] with severity, confidence, evidence
```

### AI Strategy (AI-First)

- **Model:** Gemini 2.0 Flash for everything (fast, vision-capable)
- **Temperature:** 0.0 for all calls (consistency over creativity)
- **Philosophy:** AI is the BRAIN. Heuristics are the MUSCLES. AI makes every non-trivial decision. Heuristics only handle mechanical execution (typing, clicking, scrolling) and are used as a fast-path optimization before AI calls.
- **AI decisions per step:** 2-4 Gemini calls (element picking, search query, form analysis, verification)
- **Cost:** ~$0.30-0.50 per scan. Quality over cost.
- **Central engine:** `agent/core/ai_engine.py` -- GeminiEngine class wraps all AI interactions.
- **Failure mode:** If AI fails, heuristic fallbacks still provide basic navigation. Tier 1+2 bug detection is fully deterministic.

### Bug Confidence Tiers

- **Tier 1 (HIGH, ~0% false positives):** JS errors, HTTP 5xx, broken images, missing viewport. Deterministic.
- **Tier 2 (MEDIUM, ~5-10% FP):** Slow load, poor FCP, small touch targets, missing alt text. Threshold-based.
- **Tier 3 (LOW, ~20-30% FP):** AI visual checks, form verification. Separated as "AI Suggestions."

---

## 4. Code Structure

### Core Files

**agent/core/ai_engine.py** — THE BRAIN. Central GeminiEngine class that powers all AI decisions. Methods: pick_element (AI chooses what to click), decide_search_query (AI reads page, generates realistic query), analyze_form (AI looks at form fields, decides test data), verify_action (AI sees screenshot, judges pass/fail), assess_page_quality (AI visual bug detection), decide_recovery_action (AI handles unexpected states).

**agent/core/scanner.py** — Orchestrator. Creates SiteExplorer, runs it for each viewport (desktop + mobile), calls FlowPlanner then FlowRunner on desktop, aggregates all bugs/metrics into CrawlResult.

**agent/core/explorer.py** — Phase A. Priority-queue BFS with smart waiting, SPA detection (MutationObserver), popup dismissal. Discovers interactive elements, interacts with them, builds SiteGraph.

**agent/core/flow_planner.py** — Phase B. Sends SiteGraph to Gemini 2.0 Flash, identifies 5-8 flows. Heuristic fallback if AI unavailable.

**agent/core/flow_runner.py** — Phase C. AI-powered step execution. For each step: dismiss overlays → check for login → AI picks element → AI fills forms → AI verifies outcome → state change tracking. Auth handler prompts user for creds when login detected.

**agent/utils/auth_handler.py** — Detects login screens (URL + form + content signals), prompts user for credentials via CLI, fills login form, verifies auth via redirects/cookies/dashboard elements.

**agent/utils/smart_wait.py** — Condition-based waiting: monitors spinners, skeleton screens, pending XHR, image loading, DOM stability. Replaces all fixed timeouts.

**agent/utils/popup_guard.py** — Detects and dismisses overlays: cookie banners, newsletter modals, chat widgets, GDPR dialogs, generic modals. Runs before every flow step.

**agent/utils/retry_engine.py** — Multi-strategy retry: wait longer → scroll into view → dismiss overlays → AI fallback.

**agent/utils/state_verifier.py** — Takes snapshots of browser state (cookies, localStorage, console errors, network requests, DOM hash). Compares before/after each step to detect silent failures.

**agent/utils/test_data.py** — Site-type detection, contextual search queries, unique-per-run form data, negative test values (XSS, SQL injection, empty, unicode, boundary).

**agent/utils/element_finder.py** — 6-priority heuristic chain (fast path before AI). Special "first X" / "any X" pattern handling.

**agent/utils/form_filler.py** — Heuristic form filling (fallback when AI unavailable). Regex field classification + test data.

**agent/models/context.py** — FlowContext: tracks variables, navigation history, state snapshots, console/network errors across all steps in a flow.

**agent/detectors/** — Four deterministic detectors: functional (JS errors, HTTP failures), performance (load time, FCP), responsive (overflow, touch targets), accessibility (alt text, labels).

### Data Models

**BugFinding:** title, category (functional/visual/responsive/performance/accessibility/security), severity (P0-P4), confidence (HIGH/MEDIUM/LOW), page_url, viewport, description, evidence dict.

**SiteGraph:** root_url, nodes dict[url → SiteNode], edges list[tuple]. SiteNode has: url, title, page_type, status, depth, elements list, actions list, bugs list, metrics, screenshot.

**Flow:** name, priority (1-5), steps list[FlowStep]. FlowStep: action, target, url_hint, verify.

**FlowResult:** flow, status (passed/failed/partial), steps list[FlowStepResult], duration_ms. FlowStepResult: step, status, actual_url, screenshot_b64, error, ai_used.

**CrawlResult:** url, pages_tested, bugs list, metrics list, pages_visited, errors, health_score, flows list.

---

## 5. API Contracts

### POST /api/v1/scan
Request: `{"url": "https://example.com", "max_pages": 10, "viewports": ["desktop", "mobile"]}`
Response: `{"scan_id": "abc123", "status": "running", "url": "..."}`

### GET /api/v1/scan/{id}
Returns full scan result when complete: health_score, bugs with screenshots, metrics, flows with step results, site_graph.

### GET /api/v1/scan/{id}/stream
SSE stream of live progress events: page_discovered, visiting_page, elements_found, action, bug_found, flow_step, scan_complete.

---

## 6. Deployment

- **Frontend:** Vercel auto-deploy from GitHub (flowlens.in)
- **Backend:** EC2 t3.small (ap-south-1), Nginx reverse proxy, Let's Encrypt SSL (api.flowlens.in)
- **Process manager:** PM2 alongside Kutuhal backend
- **Python:** 3.14 with venv
- **Playwright browsers:** Installed via `playwright install chromium`
- **Environment:** GEMINI_API_KEY required for AI features

---

## 7. Auth/Login Strategy

When the scanner encounters a login screen during any flow:
1. Detect login form (password input, login/signin URL, login-related text)
2. Pause execution and prompt user interactively via CLI for email + password
3. Fill the login form with provided credentials
4. Submit and verify authentication succeeded (redirect, dashboard element, session cookie)
5. Continue the flow from the authenticated state

Credentials are held in memory only, never persisted.

---

## 8. Key Design Decisions

1. **Heuristic-first, AI-assisted.** System delivers 80% of value with zero AI. If every LLM call fails, users still get all deterministic bugs, Web Vitals, and health score.

2. **Gemini 2.0 Flash everywhere.** Single model for flow planning, element finding, verification. temperature=0.0 for consistency.

3. **3-tier confidence.** Tier 1 (deterministic) → shown as bugs. Tier 2 (threshold) → shown as bugs with caveats. Tier 3 (AI) → shown separately as suggestions.

4. **Interactive auth only.** Credentials requested when login is detected, not upfront. Stored in memory only.

5. **Cost target:** < $0.10 per scan. Achieved via heuristic-first approach (95% of steps need no AI).

---

## 9. What's Being Built Next

Priority order:
1. **Login/auth engine** — detect login screens, prompt for creds, fill and verify (PRIORITY #1)
2. **Smart waiting** — replace fixed timeouts with condition-based waits (spinners, AJAX, DOM stability)
3. **Retry engine** — multi-strategy retry when elements aren't found
4. **Popup guard** — dismiss cookie banners, modals, chat widgets mid-flow
5. **Context-aware test data** — realistic search queries, unique form data per run
6. **State verification** — check cookies, localStorage, network requests after each step
7. **Flow context** — track state across steps (cart count, login state, search query)
8. **Negative testing** — try empty inputs, special characters, boundary values
9. **Conditional steps** — handle branches (if login wall → prompt creds, if CAPTCHA → skip)
10. **SPA detection** — MutationObserver for DOM-only navigations
