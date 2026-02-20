# FlowLens — Core Engineering Decisions

> The hard questions, honest answers, and design tradeoffs at the heart of the product.

---

## Decision 1: Crawling Strategy — The Hybrid Approach

**Problem:** How do you autonomously navigate a website you've never seen before?

**Decision:** Four-phase hybrid approach. AI is used surgically, not everywhere.

### Phase A: Discovery (Zero AI)

Deterministic Playwright crawl. No LLM. No guessing.

```
1. Navigate to homepage with Playwright (real Chromium)
2. Wait for full render (JS execution, AJAX calls complete)
3. Extract ALL links from RENDERED DOM (not HTML source)
   - <a href="..."> tags
   - Buttons with navigation handlers
   - SPA router links (React Router, Next.js)
4. BFS traversal: visit each link, render, extract more links
5. Build directed graph: Page A → Page B → Page C
6. Record per page: URL, title, type, forms, CTAs, DOM hash
7. Stop when: page limit reached OR no new links
```

**Hard problems and solutions:**

| Problem | Solution |
|---|---|
| SPAs (URL doesn't change) | Track DOM content hash changes. If DOM changed >30%, treat as new "page" |
| Infinite scroll | Scroll 3 times, extract new links. After 3 scrolls with no new links, move on |
| Pagination | Follow "next" links, cap at 5 pages per chain. Log pagination exists. |
| Rate limiting | 1-2s delay between requests. Respect robots.txt. Exponential backoff on 429. |
| Bot detection (Cloudflare etc.) | playwright-stealth plugin, realistic UA, JS enabled. If still blocked: report to user. |
| Dynamic content (A/B tests, ads) | Ignore ad iframes. Compare structural DOM (element types/hierarchy) not content. |

### Phase B: Flow Identification (1 LLM Call, Cached)

Single LLM call with the entire site graph as input. Not per page.

```
Input: "Here are all pages and links on myapp.com: /home → /products, /login..."
Output: Flow 1: Checkout — /home → /products → /product/123 → /cart → /checkout
        Flow 2: Login — /home → /login → /dashboard
```

Cached in Site Context. Re-run only when site graph structure changes. Cost: ~$0.01.

### Phase C: Flow Execution (Targeted AI, Heuristics First)

For each flow, navigate step by step. **LLM is the fallback, not the primary.**

```
Flow: Checkout — /home → /products → /cart → /checkout

Step 1: Go to /products → DIRECT NAVIGATION. No AI.
Step 2: Click a product → HEURISTIC: find first <a> to /products/*. No AI.
Step 3: Click "Add to Cart" → HEURISTIC: find button with text "Add to Cart"
        or aria-label containing "cart". Works ~90% of the time. No AI.
Step 4: Go to /cart → HEURISTIC: follow "Cart" or "View Cart" link. No AI.
Step 5: Fill checkout form → AI NEEDED: identify field types, generate test data
Step 6: Click submit → HEURISTIC: find submit button. No AI.
Step 7: Verify result → AI ASSIST: "Did the submission succeed?"
```

**LLM calls per 100-page crawl: ~15-30 calls, not 100+.**

The heuristic selector engine uses this priority:
1. `data-testid` attribute (if exists — most reliable)
2. `aria-label` / `aria-labelledby`
3. Visible text content (button text, link text)
4. `name` / `id` / `placeholder` attributes
5. `role` attribute
6. CSS selector matching common patterns
7. **Fallback:** LLM vision — "Which element should I click?"

### Phase D: Bug Detection (Passive, During Navigation)

Bug detectors run as listeners while the agent navigates. They don't initiate browsing.

---

## Decision 2: Bug Detection — Confidence Tiers

**Problem:** What IS a bug? How do we avoid false positives destroying user trust?

**Decision:** Three-tier confidence system. Each bug gets a confidence label.

### Tier 1: Deterministic (HIGH confidence, ~0% false positives)

These are facts, not opinions. If the condition is true, it's a bug.

| Bug | Detection | Implementation |
|---|---|---|
| JavaScript exception | `page.on('pageerror')` | Captures uncaught errors with stack trace |
| Console error | `page.on('console')` type='error' | Captures console.error() calls |
| HTTP 5xx | `page.on('response')` status >= 500 | Server errors on any network request |
| Broken resource (4xx) | `page.on('response')` status >= 400 | Missing CSS, JS, images, API 404s |
| Broken image | `img.complete === false OR img.naturalWidth === 0` | DOM check on all `<img>` elements |
| Missing viewport meta | `!document.querySelector('meta[name=viewport]')` | Single DOM query |
| Mixed content | HTTP resource on HTTPS page | Network monitor flags |

**These alone provide massive value.** Most websites have unnoticed JS errors, broken images, and 404 resources. A daily check that catches "your checkout API started returning 500 errors" is worth the entire subscription.

### Tier 2: Threshold-Based (MEDIUM confidence, ~5-10% false positives)

Industry-standard thresholds with known edge cases.

| Bug | Threshold | False positive scenarios |
|---|---|---|
| Slow page load | > 3000ms | Video-heavy pages, large dashboards |
| Poor LCP | > 2500ms | Media-intensive pages |
| High CLS | > 0.25 | Intentional animations |
| Horizontal scroll (mobile) | scrollWidth > clientWidth | Intentional horizontal carousels |
| Small touch targets | < 44x44px | Dense data tables |
| Missing form labels | Input without label | Custom components with non-standard labeling |
| Low contrast text | < 4.5:1 ratio | Decorative text, brand colors |
| Missing alt text | `<img>` without alt | Decorative images (which SHOULD have alt="") |

**Mitigation:** Snooze button + false positive marking. Fingerprint remembered forever.

### Tier 3: AI-Assisted (LOW confidence, ~20-30% false positives)

Used sparingly as a second pass. Separated in the UI.

**What works (~80% accuracy):**
- Post-form-submit verification: "Did this succeed? Is there a success message?"
- Desktop vs mobile comparison: "Are elements missing or overlapping on mobile?"
- Visual regression between crawls: "What changed? Is anything broken?"

**What doesn't work (<60% accuracy):**
- "Is this page well-designed?" — too subjective
- "Is this the right content?" — can't know intent
- Subtle CSS bugs (1px misalignment) — vision models aren't pixel-precise
- "Is this button supposed to do something?" — can't know developer intent

**UI treatment:** Tier 3 bugs go into a separate "AI Suggestions" section. NOT in the main bug list. NOT in the daily briefing by default. Opt-in only.

### How This Appears in the Product

```
DAILY BRIEFING (default: Tier 1 + Tier 2 only):

NEW BUGS (2):
  [HIGH]   HTTP 500 on /api/checkout — server error on form submit
  [MEDIUM] /checkout load time: 4.2s (threshold: 3.0s)

AI SUGGESTIONS (opt-in section, Tier 3):
  [LOW]    Mobile /pricing page — hero section may have text overlap
  [LOW]    After signup form submit — unclear if submission succeeded

DASHBOARD BUG LIST:
  Filter: [All] [High only] [High + Medium] [Include AI suggestions]
```

---

## Decision 3: AI Reliability — Design for Failure

**Problem:** LLMs are non-deterministic, make mistakes 10-20% of the time, and can hallucinate.

**Decision:** The system must deliver 80% of its value with ZERO AI. AI adds the remaining 20%.

### The Reliability Pyramid

```
Value to user:

100% ─── AI navigation + visual detection + natural language briefings
 │
 │        ← AI adds ~20% more value
 │
 80% ─── Deterministic detection + metrics + trends + alerting
 │
 │        ← This works with zero AI, zero LLM calls
 │
  0% ─── Nothing
```

**If every LLM call fails, FlowLens still:**
- Crawls all pages (Playwright, no LLM)
- Detects all Tier 1 bugs (JS errors, broken links, network errors)
- Collects all Web Vitals (LCP, CLS, FCP, load time)
- Runs axe-core accessibility checks
- Stores results with timestamps
- Computes diffs, trends, health score
- Sends daily briefing (template fallback instead of LLM-generated)
- Alerts on P0 bugs immediately

### Failure Handling

| Failure | System behavior | User sees |
|---|---|---|
| LLM API timeout | Skip AI navigation, use heuristic-only | "Some flows partially tested" |
| LLM returns invalid response | Validate structure, retry once, skip | Same as above |
| Agent stuck in loop | Anti-loop guard: kill after 3 repeated states | "Flow X could not be completed" |
| Site blocks agent | Report 403/CAPTCHA pages | "X pages not accessible (bot protection)" |
| Crawl exceeds 30 min timeout | Kill, report partial results | "Partial crawl: Y of Z pages tested" |
| LLM hallucinates a bug | Confidence: LOW, goes to AI Suggestions only | Separated from real bugs |

### Consistency Measures

Since LLMs are non-deterministic, same page might get different navigation decisions:

1. **Cache successful paths.** If Flow X was successfully navigated yesterday with a specific sequence of actions, try the same sequence today first. Only ask LLM if the cached path fails.
2. **Deterministic selectors first.** Use text/aria-label matching before asking LLM. This is deterministic and consistent.
3. **Seed the temperature.** Use temperature=0.0 for navigation decisions. We want consistency, not creativity.
4. **Validate every action.** After LLM says "click element X", verify element X exists in the DOM before clicking. If not, retry with different prompt.

---

## Decision 4: What We DON'T Try to Do (Scope Boundaries)

Being clear about limitations protects user trust and engineering focus.

**FlowLens does NOT:**
- Replace unit tests or integration tests (those test code logic, we test user experience)
- Test APIs directly (we test what users see in the browser)
- Guarantee 100% flow coverage (complex apps will have untestable flows)
- Handle CAPTCHA-protected pages (we report them as inaccessible)
- Test native mobile apps (browser only — responsive web, not iOS/Android)
- Provide pixel-perfect visual regression (we detect big layout breaks, not 1px shifts)
- Test behind corporate VPN/firewall (the site must be publicly accessible, or user must set up a tunnel)

**We are honest about these in the product:**
- Settings page shows "Flow coverage: 12 of 14 flows tested (2 flows require CAPTCHA)"
- Crawl report shows "85% of pages accessible (15% blocked by bot protection)"
- AI Suggestions section clearly labeled "These need human verification"

---

## Decision 5: Cost Model per Crawl

Understanding cost is critical for pricing and sustainability.

**Estimated cost per crawl (100-page site, daily):**

| Component | Calls/Usage | Cost |
|---|---|---|
| LLM: Flow planning | 1 call (cached, amortized) | ~$0.001 |
| LLM: Page navigation (heuristic failures only) | ~10 calls × Claude Haiku | ~$0.03 |
| LLM: Form filling | ~3 calls × Claude Sonnet | ~$0.03 |
| LLM: Visual checks (changed pages only) | ~5 calls × Claude Sonnet | ~$0.05 |
| LLM: Briefing generation | 1 call × Claude Haiku | ~$0.005 |
| Playwright browser container | ~15 min runtime | ~$0.02 |
| S3 storage (screenshots) | ~50 screenshots × 500KB | ~$0.001 |
| Database writes | ~200 rows | ~$0.001 |
| **Total per crawl** | | **~$0.14** |

At $149/month (Pro tier) with daily crawls:
- Revenue per month: $149
- Cost per month: $0.14 × 30 = $4.20
- **Gross margin: 97%**

Even at 3x the estimated LLM cost (worst case): $12.60/month, still 91% margin.

---

## Summary: The Honest Product

FlowLens is:
- **80% a very good automated checker** (deterministic bug detection + performance monitoring + historical trending)
- **20% an AI assistant** (smart navigation + visual anomaly detection + natural language briefings)

The 80% is reliable, consistent, and delivers value on day one. The 20% is impressive, gets better over time, but has known limitations.

The pitch is NOT "our AI finds all your bugs." The pitch is: **"We check your site every day so you don't have to. We catch the obvious bugs nobody is looking for. And our AI catches some of the non-obvious ones too."**

This is honest, defensible, and still enormously valuable — because most teams aren't even doing the 80% today.
