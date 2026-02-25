# FlowLens — Complete Project Context

> This single file contains EVERYTHING about FlowLens. Give this to any LLM and it can understand, modify, deploy, and extend the entire project.

---

## 1. What Is FlowLens?

FlowLens is an AI-powered QA agent for enterprises that autonomously tests web applications, discovers broken user flows, and reports issues -- a senior QA engineer, always on.

**One-liner:** Give it a URL. It tests every user flow like a senior QA engineer would.

**Domain:** flowlens.in | **API:** api.flowlens.in | **Repo:** github.com/RushikeshTammewar/flowlens

---

## 2. Business Context

**Market:** $60B+ TAM (QA testing + website monitoring). No competitor sits in the "Continuous Monitoring + Zero Config + Flow Testing" quadrant.

**Competitors:**
- QA.tech: Uses Claude, positioned as PR review tool. $29-299/mo.
- Flowtest.ai: Requires manual flow definition. No autonomous discovery.
- Momentic.ai: $15M Series A. Test authoring tool, not monitoring.
- Ranger ($8.9M), Spur ($4.5M): Adjacent but different focus.

**Target customers:** Startup CTOs (10-50 engineers, no QA team), e-commerce businesses (revenue = site uptime), agencies managing multiple client sites.

**Pricing vision:** Free scan (1 URL) -> Pro $49/mo (3 sites, daily) -> Business $149/mo (10 sites, hourly, Slack alerts).

---

## 3. Core Principles

1. **Behave like a senior QA engineer, not a link checker.** Navigate flows. Fill forms. Test login. Click CTAs. Verify outcomes.
2. **AI = brain, deterministic = muscles.** AI decides WHAT to test, WHAT to type, WHETHER the action worked. Deterministic code FINDS elements (from DOM discovery), CLICKS them, TYPES into them. AI never generates CSS selectors -- it picks element indices from the discovered list.
3. **Critical flow first.** The agent identifies THE one thing the site does (search for Q&A sites, scan for FlowLens, buy for e-commerce) and tests that FIRST. Everything else is secondary.
4. **Zero config.** Works with just a URL. Auth handled interactively when login is detected.
5. **Honest reporting.** Failed = actual bug. Blocked = auth required (not a bug). Inconclusive = can't verify. Never marks auth-gated features as "failed."

---

## 4. Architecture

### Unified QA Agent (Single Pass)

The agent discovers pages AND tests flows simultaneously. No separate phases.

```
For each page in priority queue:
  1. Navigate to page
  2. Dismiss overlays (cookie banners, modals)
  3. Check for login -> handle auth if needed
  4. Discover all interactive elements from DOM
  5. AI: Understand the site (once, on first page)
  6. AI: Assess this page (purpose, testable features, visual issues)
  7. AI: Plan 2-4 user journeys to test (critical flow FIRST)
  8. Execute each journey:
     - Steps are low-level browser commands (type/click/press_key/wait/verify)
     - Element finding is deterministic (uses DOM-discovered selectors)
     - AI only used for decisions + verification
     - If critical flow fails: AI investigates WHY and retries
  9. Run bug detectors (JS errors, performance, responsive, accessibility)
  10. Discover links, add new pages to queue
  11. Next page
```

### AI Strategy (Five Stages)

- **Stage 1: Site Understanding** -- Screenshot-based. AI identifies site type, core product, THE critical flow, main features, what needs auth.
- **Stage 2: Page Assessment** -- Before testing: AI assesses page purpose, testable features, visual issues, disabled elements.
- **Stage 3: Journey Planning** -- AI plans multi-step journeys with low-level browser commands. Critical flow is ALWAYS first (priority 10).
- **Stage 4: Step Execution** -- DETERMINISTIC. Uses DOM-discovered selectors. AI not used for finding elements.
- **Stage 5: Outcome Verification** -- AI sees screenshot and judges: passed/failed/blocked/inconclusive. Nuanced, not binary.

### Bug Confidence Tiers

- **Tier 1 (HIGH, ~0% FP):** JS errors, HTTP 5xx, broken images, missing viewport. Deterministic.
- **Tier 2 (MEDIUM, ~5-10% FP):** Slow load, poor FCP, small touch targets, missing alt text. Threshold-based.
- **Tier 3 (LOW, ~20-30% FP):** AI visual checks. Separated as "AI Suggestions."

---

## 5. Tech Stack

- **Agent:** Python 3.14 + Playwright + playwright-stealth + google-genai SDK
- **AI Model:** Gemini 2.5 Flash (temperature=0.0, 60s timeout per call)
- **Backend:** FastAPI with SSE streaming for live scan progress
- **Frontend:** Next.js 14 + Tailwind CSS + Framer Motion (Vercel auto-deploy)
- **Infrastructure:** EC2 t3.small (ap-south-1) + Nginx + Let's Encrypt SSL
- **Domain:** flowlens.in (GoDaddy), DNS -> Vercel (frontend) + Elastic IP (API)

---

## 6. File Structure

```
flowlens/
├── scan.py                              # CLI entry point
│                                        # Usage: python scan.py https://example.com --pages 5 --viewport desktop --headful
│
├── agent/
│   ├── core/
│   │   ├── qa_agent.py                  # THE MAIN AGENT. Single-pass QA with 5-stage AI.
│   │   ├── ai_engine.py                 # GeminiEngine: all AI calls (understand_site, assess_page, plan_journeys, verify_step, investigate_failure)
│   │   ├── scanner.py                   # Orchestrator: creates QAAgent, runs per viewport, aggregates results
│   │   ├── explorer.py                  # Legacy site explorer (replaced by qa_agent, kept for reference)
│   │   ├── flow_planner.py              # Legacy flow planner (replaced by qa_agent's per-page AI planning)
│   │   ├── flow_runner.py               # Legacy flow runner (replaced by qa_agent's journey execution)
│   │   ├── crawler.py                   # Legacy BFS crawler (not used)
│   │   └── report.py                    # Rich CLI report output
│   ├── detectors/
│   │   ├── functional.py                # Tier 1: JS errors, HTTP 4xx/5xx, broken images, mixed content
│   │   ├── performance.py               # Tier 2: load time, FCP, DOM node count thresholds
│   │   ├── responsive.py                # Tier 2: horizontal overflow, touch targets, font size
│   │   └── accessibility.py             # Tier 2: alt text, labels, lang attribute, page title
│   ├── models/
│   │   ├── types.py                     # BugFinding, PageMetrics, CrawlResult, Severity/Category/Confidence enums
│   │   ├── graph.py                     # SiteGraph, SiteNode, PageElement, ActionResult
│   │   ├── flow.py                      # Flow, FlowStep, ConditionalStep, FlowResult, FlowStepResult (statuses: passed/failed/blocked/inconclusive/skipped)
│   │   └── context.py                   # FlowContext: cross-step state tracking
│   ├── utils/
│   │   ├── auth_handler.py              # Login detection + headful browser login + remote browser (Xvfb) for web UI
│   │   ├── smart_wait.py                # Condition-based waiting: spinners, XHR tracker, DOM stability
│   │   ├── popup_guard.py               # Dismiss cookie banners, modals, chat widgets, GDPR dialogs
│   │   ├── element_finder.py            # Heuristic element finding (6-priority chain, fast path)
│   │   ├── form_filler.py               # Heuristic form filling with field classification
│   │   ├── retry_engine.py              # Multi-strategy retry: wait -> scroll -> dismiss -> AI
│   │   ├── state_verifier.py            # Browser state snapshots: cookies, localStorage, console errors
│   │   └── test_data.py                 # Site-type detection, contextual search queries, unique form data, negative test values
│   └── requirements.txt                 # playwright, playwright-stealth, google-genai, rich, Pillow, etc.
│
├── backend/
│   └── app/
│       ├── main.py                      # FastAPI server: scan endpoints + SSE streaming + remote browser auth endpoints
│       └── remote_browser.py            # RemoteBrowserSession: headful Playwright on Xvfb, screenshot streaming for web login
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx                     # Landing page with scan input, feature sections
│   │   ├── scan/[id]/page.tsx           # Scan results: live agent journey view + completed report
│   │   ├── layout.tsx                   # Root layout
│   │   └── globals.css                  # Tailwind + custom styles
│   ├── package.json                     # Next.js 14, framer-motion, tailwindcss
│   └── .env.local                       # NEXT_PUBLIC_API_URL=https://api.flowlens.in
│
├── infra/
│   ├── setup-ec2.sh                     # First-time EC2 setup: Python, venv, Playwright, Nginx, SSL
│   └── flowlens-api.service             # Systemd service (loads .env for GEMINI_API_KEY)
│
├── .github/workflows/
│   ├── ci.yml                           # Frontend: tsc + build. Backend: syntax check + import check.
│   └── deploy.yml                       # SSH to EC2, git pull, pip install, systemctl restart, health check.
│
├── docs/
│   ├── NORTH_STAR.md                    # Vision / HLD
│   ├── CURRENT_STATE.md                 # What's built (may be outdated, use this file instead)
│   └── PROJECT_CONTEXT.md              # Older version of this file
│
├── CONTEXT.md                           # THIS FILE -- the single source of truth
├── .env                                 # GEMINI_API_KEY + GEMINI_MODEL (gitignored)
├── .env.example                         # Template for .env
└── .gitignore                           # .env, .venv, node_modules, __pycache__, .next, etc.
```

---

## 7. Data Models

### BugFinding
```python
title: str, category: Category (functional/visual/responsive/performance/accessibility/security),
severity: Severity (P0-P4), confidence: Confidence (HIGH/MEDIUM/LOW),
page_url: str, viewport: str, description: str, evidence: dict
```

### SiteGraph
```python
root_url: str, nodes: dict[url -> SiteNode], edges: list[tuple[str,str]]
SiteNode: url, title, page_type, status (discovered/visiting/visited/failed), depth,
          elements: list[PageElement], actions: list[ActionResult], bugs, metrics, screenshot_b64
PageElement: type (nav_link/content_link/form/search/cta/dropdown), selector, text, href, priority
```

### Flow / FlowResult
```python
Flow: name, priority (1-5), steps: list[FlowStep], requires: list[str]
FlowStep: action, target, url_hint, verify
FlowResult: flow, status (passed/failed/blocked/partial), steps: list[FlowStepResult], duration_ms, context_summary
FlowStepResult: step, status (passed/failed/blocked/inconclusive/skipped), actual_url, screenshot_b64, error, ai_used, state_changes
```

### CrawlResult
```python
url, pages_tested, bugs: list[BugFinding], metrics: list[PageMetrics], pages_visited: list[str],
errors: list[str], health_score: int (0-100), flows: list[FlowResult]
```

---

## 8. API Contracts

### POST /api/v1/scan
```json
Request:  {"url": "https://example.com", "max_pages": 10, "viewports": ["desktop", "mobile"]}
Response: {"scan_id": "abc123", "status": "running", "url": "..."}
```

### GET /api/v1/scan/{id}
Returns full result when complete: health_score, bugs (with screenshots + repro steps), metrics, flows (with step results), site_graph, errors.

### GET /api/v1/scan/{id}/stream
SSE stream of live events: `page_discovered`, `visiting_page`, `elements_found`, `agent_thinking`, `flow_step`, `flow_complete`, `bug_found`, `auth_required`, `auth_frame`, `auth_complete`, `scan_complete`.

### Remote Browser Auth Endpoints
```
POST /api/v1/scan/{id}/auth/start    -- launch headful browser on Xvfb
POST /api/v1/scan/{id}/auth/click    -- relay click {x, y}
POST /api/v1/scan/{id}/auth/type     -- relay typing {text}
POST /api/v1/scan/{id}/auth/keypress -- relay key {key}
POST /api/v1/scan/{id}/auth/done     -- user confirms login complete
```
Screenshot frames streamed via SSE as `auth_frame` events.

---

## 9. Deployment

### Frontend (Vercel)
- Auto-deploys from GitHub `main` branch
- Domain: flowlens.in -> Vercel
- Env: `NEXT_PUBLIC_API_URL=https://api.flowlens.in`

### Backend (EC2)
- Instance: t3.small, ap-south-1b, Elastic IP 13.205.152.77
- OS: Ubuntu 22.04
- Domain: api.flowlens.in -> 13.205.152.77 (Nginx + Let's Encrypt SSL)
- Service: systemd `flowlens-api` (loads .env file)
- Python: 3.10 (EC2) / 3.14 (local dev)
- Process: uvicorn on port 8000, Nginx reverse proxy

### Manual Deploy
```bash
ssh ubuntu@13.205.152.77
cd ~/flowlens
git fetch origin main && git reset --hard origin/main
source .venv/bin/activate
pip install -q -r backend/requirements.txt -r agent/requirements.txt
sudo systemctl restart flowlens-api
curl -sf http://localhost:8000/health
```

### CI/CD (GitHub Actions)
- **CI** (`ci.yml`): On push to main. Frontend: tsc + build. Backend: syntax check all .py files + import check all modules.
- **Deploy** (`deploy.yml`): On push to main. SSHs to EC2, pulls code, installs deps, restarts service, health check.
- **GitHub Secrets needed:** `EC2_HOST` (13.205.152.77), `EC2_USER` (ubuntu), `EC2_SSH_KEY` (private key)

### First-Time EC2 Setup
```bash
ssh ubuntu@<ip> 'bash -s' < infra/setup-ec2.sh
# Then: sudo certbot --nginx -d api.flowlens.in
```

### Environment Variables (.env on EC2)
```
GEMINI_API_KEY=<your-gemini-api-key>
GEMINI_MODEL=gemini-2.5-flash
PYTHONUNBUFFERED=1
```

---

## 10. Auth/Login Strategy

### CLI (--headful mode)
When login detected: opens visible Chromium window, user logs in manually (handles OTP, 2FA, CAPTCHA, SSO), agent captures cookies, injects into headless session, continues.

### Web UI (Remote Browser)
When login detected: backend launches headful Playwright on Xvfb virtual display, streams screenshots at ~2fps via SSE, frontend shows live browser in modal overlay, user clicks/types directly, agent captures cookies on login success.

### Limitations
- Google/GitHub actively block automated browsers (even with stealth)
- playwright-stealth helps with most sites but not all
- Credentials never touch FlowLens -- user types directly into real browser

---

## 11. Frontend UX

### Live Scan View
- **Left panel:** Mini site map showing discovered pages, current page highlighted
- **Right panel:** Agent journey -- page-by-page narrative with flow results
- **Top bar:** Purple thinking indicator showing what AI is doing in real-time
- **Counters:** Pages, Flows (passed/total), Bugs, Elements
- **Page screenshots** appear inline as pages are completed
- **Blocked flows** shown with yellow badge (not red failed)

### Completed Report View
- Continuous scroll, no tabs: Flow Results -> Issues -> Performance -> Site Map
- Flow journey graph: horizontal pipeline of clickable step nodes
- Issues sorted by severity, expandable with repro steps + screenshots
- Performance cards with color-coded metrics
- Mobile responsive (counters stack, site map hides, grids collapse)

---

## 12. Key Design Decisions

1. **Single-pass architecture.** No separate "discovery" and "testing" phases. Every page visit IS a test. Flows appear in real-time during scanning.

2. **AI = brain, deterministic = muscles.** AI decides what to test and verifies outcomes. DOM-discovered selectors (deterministic) handle element finding and interaction. AI never generates CSS selectors.

3. **Critical flow first.** AI identifies THE most important user action and tests it first. If it fails, agent investigates and retries. Secondary features only tested after.

4. **Five-stage AI prompting.** Site understanding -> page assessment -> journey planning -> (deterministic execution) -> nuanced verification. Accumulated context across all calls.

5. **Gemini 2.5 Flash.** Single model for everything. 60s timeout per call. ~$0.30-0.50 per scan.

6. **Honest status reporting.** passed = worked. failed = actual bug. blocked = auth/permission required. inconclusive = can't determine.

---

## 13. Current Version: v0.6

Latest commit: `b6b5ad9` -- "Fix element finding: deterministic DOM selectors, not AI-generated ones"

Key capabilities:
- Single-pass QA agent with 5-stage AI strategy
- Multi-step user journey testing (search -> results -> detail)
- Critical flow identification and prioritized testing
- Failure investigation and automatic retry
- Deterministic element finding from DOM discovery
- Remote browser login for web UI (Xvfb + screenshot streaming)
- Headful browser login for CLI
- Live agent thinking indicator in frontend
- Mini site map + page screenshots in live view
- Mobile responsive frontend
- playwright-stealth for bot detection avoidance
- CI/CD pipeline (GitHub Actions -> EC2 + Vercel)

---

## 14. Known Issues / Tech Debt

- EC2 t3.small (2GB RAM) OOMs on heavy scans -- need t3.medium or swap file
- Some AI calls still timeout at 60s on slow Gemini responses
- Login detection triggers on sites with signup forms (Quora homepage = "login detected")
- google-genai SDK deprecation warnings on EC2 (Python 3.10, needs 3.11+)
- Old docs (NORTH_STAR.md, CURRENT_STATE.md, PROJECT_CONTEXT.md) are outdated -- this file is the truth
- Legacy files (explorer.py, flow_runner.py, flow_planner.py, crawler.py) still in codebase but not used by qa_agent.py

---

## 15. Roadmap

### Short-term
- Fix EC2 memory issues (swap file or upgrade)
- Improve AI prompt quality for journey planning
- Add persistent storage (PostgreSQL) for scan results
- Scheduled daily scans
- Email/Slack notifications for new bugs

### Medium-term
- Historical comparison between scans (regression detection)
- Bug lifecycle tracking (first_seen, fixed_at)
- Deploy correlation via CI/CD webhooks
- Chrome extension for seamless web login (bypasses Same-Origin Policy)
- Multi-tenant dashboard with team management

### Long-term
- Visual regression testing (screenshot comparison between scans)
- Performance trend analysis over time
- API testing (not just browser-based flows)
- Mobile app testing (React Native, Flutter web views)
