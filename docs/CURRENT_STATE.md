# FlowLens — Current State (v0.2.1)

> Last updated: February 2026

## What Works

### Site Discovery (Phase A)
- `SiteExplorer` (agent/core/explorer.py) does BFS with real browser interaction
- Discovers interactive elements: nav links, dropdowns, forms, search boxes, CTAs, buttons
- Expands menus, fills forms, clicks buttons, tests search boxes
- Builds a `SiteGraph` with nodes (pages) and edges (links)
- Captures screenshots, collects page metadata
- Handles subdomains, pagination capping, resource skipping

### Flow Identification (Phase B)
- `FlowPlanner` (agent/core/flow_planner.py) uses Gemini 2.0 Flash
- Identifies 5-8 diverse flows per site (search, login, browse, navigate, forms)
- Heuristic fallback generates 5-8 flows when AI is unavailable
- Categorizes: Transactional, Navigation, Content Access, Discovery, Engagement, Account

### Flow Execution (Phase C)
- `FlowRunner` (agent/core/flow_runner.py) executes step-by-step
- Action types: navigate, click, search, fill_form, verify
- 6-priority heuristic element finding (data-testid → aria-label → text → name → role → full text)
- AI fallback for element finding when heuristics fail
- AI vision verification (Gemini 2.0 Flash) for ambiguous outcomes
- Screenshot capture per step, pass/fail tracking

### Bug Detection (Phase D)
- **Functional** (Tier 1, HIGH confidence): JS errors, HTTP 4xx/5xx, broken images, missing viewport, mixed content
- **Performance** (Tier 2, MEDIUM): Page load > 3s, FCP > 1.8s, DOM nodes > 1500
- **Responsive** (Tier 2, MEDIUM): Horizontal overflow, small touch targets, small text on mobile
- **Accessibility** (Tier 2, MEDIUM): Missing alt text, unlabeled inputs, missing lang, missing title

### Frontend
- Next.js landing page at flowlens.in with scan input, feature sections
- Scan results page with tabs: Bugs, Performance, Flows, Site Graph
- FlowsTab with priority grouping, success rate, step-by-step details
- SSE streaming for live scan progress
- Dark-themed editorial design (Instrument Serif + IBM Plex Mono)

### Backend API
- FastAPI at api.flowlens.in with SSE streaming
- POST /api/v1/scan, GET /api/v1/scan/{id}, GET /api/v1/scan/{id}/stream
- Deployed on EC2 (ap-south-1) with Nginx + SSL

## What Was Built (v0.3 -- AI-First QA Engine)

### New: AI Brain (agent/core/ai_engine.py)
- GeminiEngine -- central AI decision maker for ALL non-trivial choices
- AI picks elements to interact with (sees element list, chooses best match)
- AI decides search queries (reads page context, generates realistic query)
- AI analyzes and fills forms (understands field types, generates appropriate data)
- AI verifies every action (sees screenshot, judges pass/fail strictly)
- AI assesses page quality (visual bug detection from screenshots)
- AI decides recovery actions (when something unexpected happens)

### New: Login/Auth (agent/utils/auth_handler.py)
- Detects login screens automatically (URL + password fields + content signals)
- Prompts user interactively via CLI for credentials
- Fills and submits login form
- Verifies auth succeeded (redirect + cookies + dashboard elements)
- Credentials stored in memory only, never persisted

### New: Smart Infrastructure
- **Smart waiting** (agent/utils/smart_wait.py): Condition-based -- detects spinners, skeleton screens, pending XHR, DOM stability
- **Popup guard** (agent/utils/popup_guard.py): Dismisses cookie banners, newsletter modals, chat widgets before every step
- **Retry engine** (agent/utils/retry_engine.py): Multi-strategy -- wait → scroll → dismiss overlays → AI fallback
- **State verifier** (agent/utils/state_verifier.py): Snapshots cookies, localStorage, console errors, network requests per step
- **SPA detection** (agent/core/explorer.py): MutationObserver + pushState/replaceState tracking

### New: Intelligent Test Data (agent/utils/test_data.py)
- Site-type detection (ecommerce, news, saas, docs, social, forum, blog)
- Contextual search queries per site type
- Unique-per-run form data (unique emails, realistic names/addresses)
- Negative test values (XSS, SQL injection, unicode, boundary)

### New: Flow Context (agent/models/context.py)
- Tracks state across all steps in a flow
- Navigation history, cookie changes, console errors, network errors
- Cross-step context for smarter verification

### New: Conditional Steps (agent/models/flow.py)
- ConditionalStep with JS condition evaluation
- Flow dependencies via `requires` field
- State changes attached to each FlowStepResult

## What's Still Missing

### Infrastructure Gaps
- **No persistent storage** -- scan results are in-memory only
- **No scheduled crawls** -- manual trigger only
- **No historical comparison** -- can't detect regressions between scans
- **Frontend flow visualization** -- FlowsTab needs interactive diagram and step replay

## File Map

```
flowlens/
├── scan.py                          # CLI entry point
├── agent/
│   ├── core/
│   │   ├── ai_engine.py             # THE BRAIN: GeminiEngine for all AI decisions
│   │   ├── crawler.py               # Legacy BFS crawler (not used)
│   │   ├── explorer.py              # Site explorer (Phase A) + SPA detection
│   │   ├── flow_planner.py          # Gemini flow identification (Phase B)
│   │   ├── flow_runner.py           # AI-powered flow execution (Phase C)
│   │   ├── scanner.py               # Orchestrator: ties A→B→C→D together
│   │   └── report.py                # Rich CLI report output
│   ├── detectors/
│   │   ├── functional.py            # JS errors, HTTP failures, broken images
│   │   ├── performance.py           # Load time, FCP, DOM node count
│   │   ├── responsive.py            # Horizontal overflow, touch targets
│   │   └── accessibility.py         # Alt text, labels, lang, title
│   ├── models/
│   │   ├── types.py                 # BugFinding, PageMetrics, CrawlResult, enums
│   │   ├── graph.py                 # SiteGraph, SiteNode, PageElement, ActionResult
│   │   ├── flow.py                  # Flow, FlowStep, ConditionalStep, FlowResult
│   │   └── context.py               # FlowContext: cross-step state tracking
│   └── utils/
│       ├── auth_handler.py          # Login detection + interactive credential prompt
│       ├── element_finder.py        # Heuristic element finding (fast path)
│       ├── form_filler.py           # Heuristic form filling (fallback)
│       ├── popup_guard.py           # Cookie banner / modal / chat widget dismissal
│       ├── retry_engine.py          # Multi-strategy retry for element finding
│       ├── smart_wait.py            # Condition-based waiting (spinners, XHR, DOM)
│       ├── state_verifier.py        # Browser state snapshots + comparison
│       └── test_data.py             # Context-aware test data + negative values
├── backend/
│   └── app/main.py                  # FastAPI server with SSE
├── frontend/
│   ├── app/page.tsx                 # Landing page
│   └── app/scan/[id]/page.tsx       # Scan results page
├── docs/
│   ├── NORTH_STAR.md                # Vision and HLD
│   ├── CURRENT_STATE.md             # This file
│   └── PROJECT_CONTEXT.md           # Complete LLM-readable project context
└── infra/
    ├── setup-ec2.sh                 # EC2 bootstrap script
    └── flowlens-api.service         # Systemd service file
```

## Cost Profile (AI-First)

- Flow identification: 1 Gemini Flash call (~$0.01)
- AI element picking: ~2-4 calls per flow step
- AI search query generation: 1 call per search step
- AI form analysis: 1 call per form step
- AI action verification: 1 call per step (screenshot-based)
- AI recovery decisions: 0-2 calls per flow (only on failure)
- Total per scan: ~$0.30-0.50 (6 flows, ~5 steps each)
- Scan time: 3-5 minutes for 5-6 pages
