# FlowLens v2 Architecture — Browser-Use Powered Navigation

> **v2 replaces FlowLens's hand-rolled DOM discovery + CSS-selector clicking with
> Browser-Use's CDP three-tree fusion + LLM-driven navigation.**
> FlowLens keeps its QA intelligence (what to test, how to verify).
> Browser-Use handles the browser (how to navigate, find elements, click).

---

## System Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Entry Points                                │
│   scan.py (CLI)  ←───→  backend/app/main.py (FastAPI + SSE)         │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       FlowLensScanner                                │
│   Orchestrator: viewport management, result aggregation,             │
│   health score, screenshot collection, deduplication                 │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          QAAgent                                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                 GeminiEngine (QA Brain)                         │  │
│  │                                                                │  │
│  │  Stage 1: understand_site()                                    │  │
│  │    → "E-commerce site. Critical flow: search → product → buy"  │  │
│  │                                                                │  │
│  │  Stage 2: assess_page()                                        │  │
│  │    → "Product listing with search, filters, 24 products"       │  │
│  │                                                                │  │
│  │  Stage 3: plan_journeys()                                      │  │
│  │    → Task: "Search 'laptop', verify results show products"     │  │
│  │    → Task: "Click first product, verify price is displayed"    │  │
│  │                                                                │  │
│  │  Stage 4: verify_outcome()                                     │  │
│  │    → "PASSED: 15 laptop results with prices and images"        │  │
│  │    → "FAILED: product page shows 404 error"                    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │              NavigationEngine (Hands)                           │  │
│  │              *** Powered by Browser-Use ***                     │  │
│  │                                                                │  │
│  │  navigate_to(url)        → Direct URL navigation               │  │
│  │  execute_task(task)      → LLM-driven autonomous navigation    │  │
│  │  get_page_state()        → Screenshot + URL + title            │  │
│  │  execute_javascript(js)  → Run JS for bug detectors            │  │
│  │  get_links(domain)       → Discover outgoing links             │  │
│  └─────────────────────────────────┬──────────────────────────────┘  │
│                                    │                                  │
│  ┌─────────────────────────────────┴──────────────────────────────┐  │
│  │                     Bug Detectors                               │  │
│  │  Tier 1 (HIGH): JS errors, broken images, missing viewport     │  │
│  │  Tier 2 (MED):  Load time, FCP, DOM size, touch targets        │  │
│  │  Tier 3 (LOW):  AI visual checks (screenshot-based)            │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Browser-Use Library                             │
│                                                                      │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────────────┐ │
│  │  DomService   │  │  Agent Loop    │  │  CDP Actions             │ │
│  │               │  │                │  │                          │ │
│  │  DOM tree     │  │  1. Observe    │  │  Input.dispatchMouse     │ │
│  │  + AX tree    │  │  2. Think(LLM) │  │  Input.dispatchKey       │ │
│  │  + Snapshot   │  │  3. Act(CDP)   │  │  Runtime.evaluate        │ │
│  │  = 3-tree     │  │  4. Verify     │  │  Page.navigate           │ │
│  │    fusion     │  │  5. Repeat     │  │  DOM.getDocument         │ │
│  └──────────────┘  └────────────────┘  └──────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ClickableElementDetector (7 layers)                           │  │
│  │  JS click listeners → HTML tags → ARIA roles → AX properties  │  │
│  │  → search attributes → event handlers → cursor:pointer         │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Chrome / Chromium (local, via CDP)                       │
│              No cloud. No Selenium. No Playwright high-level API.     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: A Single Scan

```
User runs:  python scan.py https://shop.example.com --pages 10

1. Scanner → NavigationEngine.start()
   └→ Browser-Use launches Chrome via CDP

2. NavigationEngine.navigate_to("https://shop.example.com")
   └→ CDP: Page.navigate → wait for load
   └→ Returns: PageState(url, title, screenshot_b64)

3. GeminiEngine.understand_site(page_state)
   └→ Sends screenshot to Gemini Flash
   └→ Returns: "E-commerce, core flow: search → product → checkout"

4. MAIN LOOP (for each page in queue, up to max_pages):
   │
   ├─ NavigationEngine.navigate_to(page_url)
   │
   ├─ GeminiEngine.assess_page(page_state)
   │  └→ "Search bar, 3 categories, featured products, cart icon"
   │
   ├─ GeminiEngine.plan_journeys(page_state, assessment)
   │  └→ Journey 1: "Search for 'wireless headphones', verify results"
   │  └→ Journey 2: "Click 'Electronics' category, verify products load"
   │
   ├─ For each journey:
   │  │
   │  ├─ NavigationEngine.execute_task(journey.task)
   │  │  └→ Browser-Use Agent autonomously:
   │  │     1. Finds search box (CDP 3-tree fusion)
   │  │     2. Types 'wireless headphones' (CDP keyboard)
   │  │     3. Presses Enter (CDP keyboard)
   │  │     4. Waits for results (network idle)
   │  │     5. Returns: NavigationResult(success, url, actions)
   │  │
   │  ├─ NavigationEngine.get_page_state()
   │  │  └→ Screenshot + URL of results page
   │  │
   │  ├─ GeminiEngine.verify_outcome(page_state, expected)
   │  │  └→ "PASSED: 12 headphone products with prices"
   │  │
   │  └─ NavigationEngine.navigate_to(original_page_url)
   │
   ├─ Bug Detectors (via execute_javascript):
   │  ├─ FunctionalDetector: JS errors, broken images
   │  ├─ PerformanceDetector: load time, FCP, DOM nodes
   │  └─ ResponsiveDetector: overflow, touch targets
   │
   └─ Discover links → add to page queue

5. Generate report: health_score, bugs, flow results, site map
```

---

## v1 vs v2 Comparison

| Aspect | v1 (hand-rolled) | v2 (Browser-Use) |
|--------|-------------------|-------------------|
| Element discovery | 7 hardcoded CSS queries | CDP 3-tree fusion (DOM + AX + Snapshot) |
| Clickable detection | Tag-based (nav, form, button, a) | 7-layer (listeners, tags, ARIA, AX, cursor) |
| Element interaction | `page.query_selector(css).click()` | CDP `Input.dispatchMouseEvent` at bbox center |
| Shadow DOM | Missed | Full support |
| Iframes | Missed | Recursive processing |
| AI role in execution | Picks element indices from text list | Plans high-level tasks, Browser-Use handles HOW |
| Error recovery | None (retry_engine exists but unused) | Memory + consecutive failure tracking + fallback LLM |
| Auth | Xvfb screenshot streaming | `storage_state` + `sensitive_data` + Chrome profiles |
| Benchmark equivalent | Unknown (likely ~50-60%) | ~89% (Browser-Use on WebVoyager) |
| Dependencies | Playwright + custom JS | Browser-Use (CDP + LLM) |

---

## Key Design Decisions

1. **FlowLens = brain, Browser-Use = hands.** FlowLens decides WHAT to test (QA intelligence).
   Browser-Use decides HOW to navigate (element finding, clicking, typing).

2. **Natural language tasks.** Journey planning outputs human-readable task descriptions
   ("Search for 'laptop' and verify results"), not low-level browser commands
   (`{"action": "type", "element_index": 3}`). Browser-Use handles decomposition.

3. **Shared browser session.** One Chrome instance per scan. Browser-Use's session
   persists cookies, auth state, and page context across all navigation tasks.

4. **Detectors via JS evaluation.** Bug detectors run JavaScript through Browser-Use's
   CDP connection. No separate Playwright instance needed.

5. **Gemini Flash for everything.** Both FlowLens's QA AI and Browser-Use's navigation
   AI use Gemini Flash. Single API key, consistent cost (~$0.30-0.50/scan).

---

## Requirements

- Python >= 3.11 (Browser-Use requirement)
- `pip install browser-use` (includes Chrome/CDP management)
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable
- Chrome/Chromium installed (or `uvx browser-use install`)
