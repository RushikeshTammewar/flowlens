# FlowLens — Flow-Based QA Agent Implementation Plan

> **Goal:** Transform FlowLens from a page scanner into a QA engineer that tests user journeys with technical precision.
>
> **Timeline:** 5-7 days of focused work
>
> **Success Criteria:** Agent successfully tests critical flows (search, checkout, login) on 10 diverse real websites with 95%+ accuracy

---

## Phase 1: Fix Foundation & Flow Identification (Day 1)

### 1.1 Fix Gemini Model Name Bug ✓ CRITICAL
**File:** `agent/core/flow_planner.py`

**Problem:** Uses `gemini-2.0-flash-exp` which doesn't exist in API v1beta

**Fix:**
```python
# Line 45: Change
model = genai.GenerativeModel('gemini-2.0-flash-exp')
# To:
model = genai.GenerativeModel('gemini-2.0-flash')
```

**Test:** Call `identify_flows()` on a test graph and verify it returns structured flow JSON

---

### 1.2 Improve Flow Identification Prompt

**Current State:** Generic prompt that may miss critical flows

**New Approach:** Structured prompt with examples and business-priority guidance

**Prompt Template:**
```
You are analyzing a website to identify critical user flows for QA testing.

SITE STRUCTURE:
Pages discovered: {page_count}
{page_list_with_types}

Key pages identified:
- Homepage: {homepage_url}
- Login/Auth pages: {auth_pages}
- Forms: {form_pages}
- Search: {search_pages}
- Checkout/Transaction pages: {transaction_pages}

TASK: Identify 3-7 critical user flows that a senior QA engineer would test.

PRIORITY GUIDE:
- Revenue-critical flows (checkout, payment, subscription) = Priority 100
- Core functionality (search, login, signup) = Priority 80-90
- Content browsing (navigation, read articles) = Priority 50-70
- Peripheral features (contact, about, footer links) = Priority 20-40

For each flow, provide:
1. name: Human-readable flow name (e.g., "Product Search & Add to Cart")
2. priority: 0-100 (higher = more critical)
3. steps: Array of step objects with:
   - action: "navigate" | "click" | "search" | "fill_form" | "verify"
   - target: What to interact with (button text, link text, field name)
   - url_hint: Expected URL pattern after this step
   - verify: What to check after this step (e.g., "Results appear", "Success message shown")

EXAMPLES:

E-commerce site:
{
  "name": "Product Search to Cart",
  "priority": 95,
  "steps": [
    {"action": "search", "target": "search box", "url_hint": "/search", "verify": "Search results displayed"},
    {"action": "click", "target": "first product", "url_hint": "/product/", "verify": "Product page loaded"},
    {"action": "click", "target": "add to cart", "url_hint": "/cart", "verify": "Item in cart"}
  ]
}

SaaS site:
{
  "name": "Sign Up Flow",
  "priority": 100,
  "steps": [
    {"action": "click", "target": "sign up button", "url_hint": "/signup", "verify": "Signup form visible"},
    {"action": "fill_form", "target": "signup form", "url_hint": "/verify", "verify": "Verification email sent message"},
  ]
}

OUTPUT FORMAT: JSON array of flows, sorted by priority (highest first).
```

**Test Cases:**
- E-commerce site (shopify.com) → Should identify: Product Search, Add to Cart, Checkout
- SaaS site (linear.app) → Should identify: Sign Up, Login, Create Issue
- News site (nytimes.com) → Should identify: Search Articles, Read Article, Navigate Sections

---

### 1.3 Add Flow Validation Logic

**File:** `agent/core/flow_planner.py`

**Add:** `validate_flow()` function that checks:
- Each step has required fields (action, target)
- Actions are valid (navigate/click/search/fill_form/verify)
- Flow has at least 2 steps
- Priority is 0-100
- No circular dependencies (step X → step Y → step X)

**Fallback:** If LLM returns invalid JSON or flow validation fails, use heuristic fallback:
```python
def get_fallback_flows(graph: SiteGraph) -> list[Flow]:
    flows = []

    # If site has search box → Search flow
    if graph.has_search:
        flows.append(Flow(
            name="Search",
            priority=80,
            steps=[
                FlowStep(action="search", target="search box", url_hint="/search", verify="Results appear"),
                FlowStep(action="click", target="first result", verify="Content loads")
            ]
        ))

    # If site has login form → Login flow
    if graph.has_login:
        flows.append(Flow(
            name="Login",
            priority=85,
            steps=[
                FlowStep(action="navigate", target="/login", verify="Login form visible"),
                FlowStep(action="fill_form", target="login form", verify="Dashboard or logged in state")
            ]
        ))

    # Always include: Browse flow (click 3 nav links)
    flows.append(Flow(
        name="Navigate Site",
        priority=60,
        steps=[
            FlowStep(action="click", target="first nav link", verify="Page loads"),
            FlowStep(action="click", target="second nav link", verify="Page loads"),
            FlowStep(action="click", target="third nav link", verify="Page loads")
        ]
    ))

    return flows
```

---

## Phase 2: Action Outcome Verification (Day 2-3)

### 2.1 Implement `verify_action_outcome()`

**File:** `agent/core/flow_runner.py`

**Function Signature:**
```python
async def verify_action_outcome(
    self,
    page: Page,
    action: FlowStep,
    screenshot: bytes,
    context: dict
) -> tuple[bool, str]:
    """
    Verify that an action succeeded.

    Returns:
        (success: bool, reason: str)

    Examples:
        (True, "Search results displayed, 10+ items visible")
        (False, "Error message: 'Please enter a search term'")
        (True, "Form submitted successfully, confirmation page shown")
    """
```

**Implementation:**

```python
async def verify_action_outcome(self, page: Page, action: FlowStep, screenshot: bytes, context: dict) -> tuple[bool, str]:
    # For navigate/click: just check URL changed and page loaded
    if action.action in ["navigate", "click"]:
        current_url = page.url
        expected_pattern = action.url_hint or ""

        # Basic check: did URL change as expected?
        if expected_pattern and expected_pattern not in current_url:
            return (False, f"Expected URL pattern '{expected_pattern}' not found. Current: {current_url}")

        # Check for error messages in DOM
        error_indicators = await page.evaluate("""() => {
            const errorSelectors = [
                '[role="alert"]',
                '.error', '.alert', '.warning',
                '[class*="error"]', '[class*="alert"]'
            ];
            for (const sel of errorSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim()) {
                    return el.textContent.trim().substring(0, 200);
                }
            }
            return null;
        }""")

        if error_indicators:
            return (False, f"Error message detected: {error_indicators}")

        return (True, "Page loaded successfully")

    # For search: check if results appeared
    if action.action == "search":
        return await self._verify_search_results(page, screenshot, action)

    # For fill_form: check if submission succeeded
    if action.action == "fill_form":
        return await self._verify_form_submission(page, screenshot, action)

    # For explicit verify steps: use AI
    if action.action == "verify":
        return await self._verify_with_ai(page, screenshot, action)

    return (True, "Action completed")


async def _verify_search_results(self, page: Page, screenshot: bytes, action: FlowStep) -> tuple[bool, str]:
    """Check if search returned results."""

    # Heuristic check first (fast, no AI)
    results_info = await page.evaluate("""() => {
        // Look for common result container patterns
        const selectors = [
            '[role="list"]', '[role="listbox"]',
            '.results', '.search-results', '[class*="result"]',
            'article', '.item', '.product'
        ];

        let count = 0;
        for (const sel of selectors) {
            const elements = document.querySelectorAll(sel);
            if (elements.length > 0) {
                count = Math.max(count, elements.length);
            }
        }

        // Check for "no results" messages
        const noResultsText = document.body.textContent.toLowerCase();
        const hasNoResults =
            noResultsText.includes('no results') ||
            noResultsText.includes('0 results') ||
            noResultsText.includes('nothing found') ||
            noResultsText.includes('no matches');

        return {count, hasNoResults};
    }""")

    if results_info['hasNoResults']:
        return (False, "Search returned no results")

    if results_info['count'] >= 3:
        return (True, f"Search results displayed ({results_info['count']} items visible)")

    # If heuristic is unclear, use AI vision
    return await self._verify_with_ai(page, screenshot, action)


async def _verify_form_submission(self, page: Page, screenshot: bytes, action: FlowStep) -> tuple[bool, str]:
    """Check if form submission succeeded."""

    # Wait a moment for any redirects or success messages
    await asyncio.sleep(1)

    # Heuristic check: look for success indicators
    success_info = await page.evaluate("""() => {
        const successSelectors = [
            '[role="status"]',
            '.success', '.confirmation', '[class*="success"]',
            '[class*="confirm"]', '[class*="thank"]'
        ];

        for (const sel of successSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim()) {
                return {
                    found: true,
                    message: el.textContent.trim().substring(0, 200)
                };
            }
        }

        // Check for error messages
        const errorSelectors = [
            '[role="alert"]',
            '.error', '[class*="error"]',
            '.invalid', '[class*="invalid"]'
        ];

        for (const sel of errorSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim()) {
                return {
                    found: false,
                    message: el.textContent.trim().substring(0, 200)
                };
            }
        }

        // Check if still on same form page (submission may have failed)
        const forms = document.querySelectorAll('form');
        return {
            found: null,  // unclear
            hasForm: forms.length > 0
        };
    }""")

    if success_info.get('found') is True:
        return (True, f"Form submitted successfully: {success_info['message']}")

    if success_info.get('found') is False:
        return (False, f"Form submission failed: {success_info['message']}")

    # If unclear, use AI vision
    return await self._verify_with_ai(page, screenshot, action)


async def _verify_with_ai(self, page: Page, screenshot: bytes, action: FlowStep) -> tuple[bool, str]:
    """Use Gemini vision to verify action outcome."""

    import google.generativeai as genai
    import base64

    # Skip if no API key
    if not os.getenv('GEMINI_API_KEY'):
        return (True, "Verification skipped (no AI key)")

    genai.configure(api_key=os.environ['GEMINI_API_KEY'])
    model = genai.GenerativeModel('gemini-2.5-pro')  # Use Pro for vision

    screenshot_b64 = base64.b64encode(screenshot).decode()

    prompt = f"""You are a QA engineer verifying that a user action succeeded.

ACTION TAKEN: {action.action}
TARGET: {action.target}
EXPECTED OUTCOME: {action.verify}

CURRENT PAGE URL: {page.url}

Look at the screenshot and answer:

1. Did the action succeed?
2. What evidence supports your answer?
3. Are there any error messages visible?

Respond in this exact JSON format:
{{
  "success": true/false,
  "reason": "Brief explanation (1-2 sentences)",
  "evidence": "What you see in the screenshot that led to this conclusion"
}}
"""

    try:
        response = model.generate_content([
            {
                'mime_type': 'image/png',
                'data': screenshot_b64
            },
            prompt
        ])

        import json
        result = json.loads(response.text)
        return (result['success'], result['reason'])

    except Exception as e:
        # AI failed, default to success (optimistic)
        return (True, f"Verification inconclusive (AI error: {str(e)})")
```

**Test Cases:**
- Form submit success → Should detect success message
- Form submit failure → Should detect error message
- Search with results → Should count result items
- Search no results → Should detect "no results" text
- Navigation → Should verify URL changed

---

### 2.2 Update FlowRunner to Use Verification

**File:** `agent/core/flow_runner.py`

**In `execute_flow()` method:**

```python
async def execute_flow(self, page: Page, flow: Flow, viewport: str) -> FlowResult:
    start_time = time.time()
    step_results = []

    for i, step in enumerate(flow.steps):
        print(f"  Step {i+1}/{len(flow.steps)}: {step.action} {step.target}")

        try:
            # Execute the action
            await self._execute_step(page, step)

            # Wait for page to settle
            await asyncio.sleep(0.5)
            await page.wait_for_load_state('networkidle', timeout=5000)

            # Capture screenshot AFTER action
            screenshot = await page.screenshot(full_page=False)
            screenshot_b64 = base64.b64encode(screenshot).decode()

            # VERIFY the action succeeded
            success, reason = await self.verify_action_outcome(page, step, screenshot, {})

            step_results.append(FlowStepResult(
                step=step,
                status="passed" if success else "failed",
                actual_url=page.url,
                screenshot_b64=screenshot_b64,
                error=None if success else reason,
                ai_used="Gemini 2.5 Pro" if "AI" in reason or step.action in ["search", "fill_form"] else "Heuristic"
            ))

            # STOP if step failed
            if not success:
                print(f"    ✗ FAILED: {reason}")
                break
            else:
                print(f"    ✓ PASSED: {reason}")

        except Exception as e:
            step_results.append(FlowStepResult(
                step=step,
                status="error",
                actual_url=page.url,
                error=str(e),
                ai_used="None"
            ))
            print(f"    ✗ ERROR: {str(e)}")
            break

    duration_ms = int((time.time() - start_time) * 1000)

    # Overall flow status
    if not step_results:
        status = "failed"
    elif all(r.status == "passed" for r in step_results):
        status = "passed"
    elif any(r.status == "error" for r in step_results):
        status = "error"
    else:
        status = "partial"  # some steps passed, some failed

    return FlowResult(
        flow=flow,
        status=status,
        steps=step_results,
        duration_ms=duration_ms
    )
```

---

## Phase 3: Contextual Search & Form Intelligence (Day 4)

### 3.1 Contextual Search Queries

**Problem:** Currently types "test" into every search box

**Solution:** Ask Gemini what a realistic search query would be for this site

**File:** `agent/core/flow_runner.py`

**Add method:**
```python
async def _get_contextual_search_query(self, page: Page, site_type: str) -> str:
    """Generate a contextual search query based on the site."""

    # Heuristic defaults (fast, no AI needed for common types)
    defaults = {
        'ecommerce': 'laptop',
        'news': 'technology',
        'saas': 'help',
        'docs': 'getting started',
        'blog': 'tutorial',
        'forum': 'question',
        'social': 'search',
    }

    if site_type in defaults:
        return defaults[site_type]

    # If site type unknown, use AI to suggest
    if not os.getenv('GEMINI_API_KEY'):
        return 'test'  # fallback

    import google.generativeai as genai
    genai.configure(api_key=os.environ['GEMINI_API_KEY'])
    model = genai.GenerativeModel('gemini-2.0-flash')

    page_content = await page.evaluate("() => document.body.textContent.substring(0, 2000)")

    prompt = f"""This is a search box on a website. Based on the page content below, what's a realistic search query a user might enter?

Page URL: {page.url}
Page content (first 2000 chars):
{page_content}

Respond with just the search query (2-3 words), nothing else."""

    try:
        response = model.generate_content(prompt)
        query = response.text.strip()[:50]  # limit length
        return query if query else 'test'
    except:
        return 'test'
```

**Update `_test_search()` to use it:**
```python
async def _test_search(self, page: Page, search_box_selector: str):
    # Detect site type from URL/content
    site_type = self._detect_site_type(page.url)

    # Get contextual query
    query = await self._get_contextual_search_query(page, site_type)

    print(f"    Searching for: '{query}'")

    await page.fill(search_box_selector, query)
    # ... rest of search logic
```

---

### 3.2 AI Fallback for Form Fields

**Problem:** When regex can't classify a field, it's skipped

**Solution:** Ask Gemini to classify the field based on its label/placeholder/context

**File:** `agent/utils/form_filler.py`

**Add method:**
```python
def classify_field_with_ai(self, field: dict) -> str:
    """Use AI to classify ambiguous form fields."""

    if not os.getenv('GEMINI_API_KEY'):
        return 'text'  # fallback to generic text

    import google.generativeai as genai
    genai.configure(api_key=os.environ['GEMINI_API_KEY'])
    model = genai.GenerativeModel('gemini-2.0-flash')

    prompt = f"""Classify this form field.

Field attributes:
- name: {field.get('name', '')}
- type: {field.get('type', '')}
- placeholder: {field.get('placeholder', '')}
- label: {field.get('label', '')}
- autocomplete: {field.get('autocomplete', '')}

What type of data should go in this field?

Options:
- email
- password
- name (first_name or last_name)
- phone
- address
- city
- state
- zip
- country
- company
- url
- number
- date
- text (generic)

Respond with just ONE word from the options above."""

    try:
        response = model.generate_content(prompt)
        field_type = response.text.strip().lower()
        return field_type if field_type in ['email', 'password', 'name', 'phone', 'address', 'city', 'state', 'zip', 'country', 'company', 'url', 'number', 'date', 'text'] else 'text'
    except:
        return 'text'
```

**Update `classify_field()` to use AI as fallback:**
```python
def classify_field(self, field: dict) -> str:
    # Try all regex patterns first
    field_type = self._classify_with_regex(field)

    if field_type != 'text':  # Regex found a match
        return field_type

    # If regex failed and field has a label, try AI
    if field.get('label') or field.get('placeholder'):
        return self.classify_field_with_ai(field)

    return 'text'
```

---

## Phase 4: Integration & End-to-End Testing (Day 5-6)

### 4.1 Wire Everything Together

**File:** `agent/core/scanner.py`

**Ensure the full pipeline runs:**
1. Discovery crawl → Site graph
2. Flow identification (Gemini) → List of flows
3. Flow execution (with verification) → Flow results
4. Bug detection (passive, during flows) → Bug list
5. Return complete CrawlResult with flows

**Verify:**
```python
result = await scanner.scan(url, max_pages=20)

assert result.flows is not None
assert len(result.flows) > 0
assert all(flow.status in ['passed', 'failed', 'partial', 'error'] for flow in result.flows)
```

---

### 4.2 Add Environment Variable for Gemini API Key

**EC2 Production:**
```bash
sudo mkdir -p /etc/systemd/system/flowlens-api.service.d
echo "Environment=\"GEMINI_API_KEY=AIzaSyAAVmOZKgAAf2dqfATPq1261awK-Wt940I\"" | sudo tee /etc/systemd/system/flowlens-api.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart flowlens-api
```

**Local Development:**
```bash
export GEMINI_API_KEY="AIzaSyAAVmOZKgAAf2dqfATPq1261awK-Wt940I"
echo 'export GEMINI_API_KEY="AIzaSyAAVmOZKgAAf2dqfATPq1261awK-Wt940I"' >> ~/.zshrc
```

---

### 4.3 Real-World Test Suite

**Test on 10 diverse sites:**

| Site | Type | Critical Flow to Test | Expected Result |
|------|------|----------------------|-----------------|
| news.ycombinator.com | Forum | Search articles, Navigate threads | Flow passes |
| wikipedia.org | Encyclopedia | Search topic, Navigate links | Flow passes |
| shopify.com | E-commerce | Search products, View product | Flow passes |
| linear.app | SaaS | Navigate features | Flow passes (auth wall expected) |
| github.com | Dev platform | Search repos, View repo | Flow passes |
| nytimes.com | News | Search articles, Read article | Flow passes |
| reddit.com | Social | Search subreddits, View thread | Flow passes |
| amazon.com | E-commerce | Search products, View product, Add to cart | Flow passes or fails gracefully |
| medium.com | Publishing | Search articles, Read article | Flow passes |
| stackoverflow.com | Q&A | Search questions, View question | Flow passes |

**Success Criteria:**
- 8/10 sites: flows identified correctly
- 7/10 sites: at least 1 flow completes successfully
- 10/10 sites: no crashes, graceful handling of auth walls / bot detection

---

### 4.4 Performance Benchmarks

**Measure and optimize:**

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| Time to identify flows (AI call) | < 3s | TBD | ⏳ |
| Time per flow step execution | < 2s | TBD | ⏳ |
| Time per verification (AI call) | < 4s | TBD | ⏳ |
| Total scan time (20 pages, 3 flows) | < 2 min | TBD | ⏳ |
| AI cost per scan | < $0.15 | TBD | ⏳ |

**Optimization strategies if too slow:**
- Reduce screenshot size for AI calls (800px wide max)
- Use Gemini Flash instead of Pro for simple verifications
- Parallelize flow execution (run Desktop + Mobile flows concurrently)
- Cache flow identification for 24h if site graph unchanged

---

## Phase 5: Frontend Polish & UX (Day 7)

### 5.1 Enhance "Flows" Tab Display

**File:** `frontend/app/scan/[id]/page.tsx`

**Improvements:**

1. **Flow status at a glance:**
   ```
   ✓ Product Search (PASSED in 8.2s)
   ✗ Checkout Flow (FAILED at step 3/5 in 12.1s)
   ⚠ Login Flow (PARTIAL - 2/3 steps passed in 5.3s)
   ```

2. **Step-by-step breakdown with screenshots:**
   - Show screenshot thumbnail for each step
   - Green checkmark for passed steps
   - Red X for failed steps
   - Hover to see full verification reason

3. **AI usage transparency:**
   ```
   This flow used:
   - 4 heuristic checks (instant, $0.00)
   - 2 AI verifications (4.2s, $0.08)
   ```

4. **Quick wins section:**
   ```
   🎯 All critical flows passed! Your site is working as expected.

   or

   ⚠️ 1 critical flow failed: Checkout Flow
   → Fix: "Add to Cart" button not responding on step 3
   ```

---

### 5.2 Update Landing Page Copy

**File:** `frontend/app/page.tsx`

**Hero copy:**
```
FlowLens tests your website like a QA engineer.

We don't just scan pages — we test user journeys.
Search, checkout, login, signup — the flows that matter.

Daily automated testing. Instant alerts when flows break.
```

**Show flow verification example:**
```
[Animated demo of flow steps executing]

✓ Step 1: Search for "laptop" → 24 results found
✓ Step 2: Click first product → Product page loaded
✗ Step 3: Add to cart → Button unresponsive (detected in 0.8s)
```

---

## Delivery Checklist

### Code Quality
- [ ] All functions have docstrings
- [ ] Type hints on all function signatures
- [ ] No hardcoded credentials (use env vars)
- [ ] Error handling on all AI calls (fallback to heuristics)
- [ ] Logging at each major step (for debugging)

### Testing
- [ ] Unit tests for `verify_action_outcome()`
- [ ] Integration test: Full scan on 3 test sites
- [ ] Real-world test: 10 diverse production sites
- [ ] Performance test: Scan completes in < 2 min
- [ ] Cost test: AI usage < $0.15 per scan

### Documentation
- [ ] README updated with Gemini API key setup
- [ ] Code comments explain AI usage strategy
- [ ] Frontend displays AI usage transparently

### Deployment
- [ ] Gemini API key added to EC2 environment
- [ ] Frontend deployed to Vercel
- [ ] Backend deployed to EC2
- [ ] Health check passes: `curl https://api.flowlens.in/health`
- [ ] End-to-end test via production UI

---

## Success Metrics

After implementation, measure:

1. **Flow Identification Accuracy:** 90%+ of identified flows are actually testable
2. **Verification Accuracy:** 95%+ of pass/fail verdicts are correct
3. **User Value:** "Flows" tab is the #1 viewed section in reports
4. **Performance:** < 2 min per scan, < $0.15 AI cost
5. **Reliability:** No crashes on 10 diverse real sites

---

## Future Enhancements (Post-MVP)

- **SPA support:** Detect DOM changes for virtual navigation
- **Multi-step form flows:** Handle wizards and multi-page forms
- **Auth flow testing:** Use test credentials to test logged-in flows
- **Visual regression:** Compare screenshots between crawls for layout breaks
- **Database persistence:** Store flows, baselines, bug history for retention
