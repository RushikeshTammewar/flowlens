# FlowLens — Low Level Design

> Last updated: February 2026

---

## Table of Contents

1. [Database Schema](#1-database-schema)
2. [Agent Implementation](#2-agent-implementation)
3. [Bug Detection Algorithms](#3-bug-detection-algorithms)
4. [Analytics Algorithms](#4-analytics-algorithms)
5. [API Contracts](#5-api-contracts)
6. [Notification System](#6-notification-system)
7. [LLM Integration](#7-llm-integration)

---

## 1. Database Schema

### 1.1 PostgreSQL — Core Tables

```sql
-- USERS (synced from Clerk via webhook)
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clerk_id        TEXT UNIQUE NOT NULL,
    email           TEXT NOT NULL,
    name            TEXT,
    avatar_url      TEXT,
    timezone        TEXT DEFAULT 'America/New_York',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- PROJECTS (a website being monitored)
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,              -- "My App"
    url             TEXT NOT NULL,              -- "https://myapp.com"
    crawl_schedule  TEXT DEFAULT 'daily',       -- daily | hourly | weekly
    crawl_time      TIME DEFAULT '02:00',       -- when to run daily crawl
    auth_config     BYTEA,                      -- encrypted auth credentials
    viewport_config JSONB DEFAULT '["desktop", "mobile"]',
    max_pages       INT DEFAULT 500,
    status          TEXT DEFAULT 'active',      -- active | paused | onboarding
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_projects_owner ON projects(owner_id);
CREATE INDEX idx_projects_status ON projects(status);

-- CRAWLS (a single crawl execution)
CREATE TABLE crawls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    trigger_type    TEXT NOT NULL,              -- scheduled | deploy | manual | free_scan
    status          TEXT DEFAULT 'pending',     -- pending | running | analyzing | completed | failed
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    pages_tested    INT DEFAULT 0,
    flows_tested    INT DEFAULT 0,
    bugs_found      INT DEFAULT 0,
    new_bugs        INT DEFAULT 0,
    fixed_bugs      INT DEFAULT 0,
    health_score    INT,                        -- 0-100, computed after analysis
    health_delta    INT,                        -- change from previous crawl
    deploy_sha      TEXT,                       -- if deploy-triggered
    error_message   TEXT,                       -- if failed
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_crawls_project ON crawls(project_id);
CREATE INDEX idx_crawls_project_created ON crawls(project_id, created_at DESC);
CREATE INDEX idx_crawls_status ON crawls(status);

-- BUGS (every bug ever found, with lifecycle)
CREATE TABLE bugs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint     TEXT NOT NULL,              -- dedup hash
    status          TEXT DEFAULT 'open',        -- open | fixed | snoozed | false_positive
    severity        TEXT NOT NULL,              -- P0 | P1 | P2 | P3 | P4
    category        TEXT NOT NULL,              -- functional | visual | responsive | performance | accessibility | security
    title           TEXT NOT NULL,              -- human-readable title
    description     TEXT,                       -- detailed AI-generated description
    page_url        TEXT NOT NULL,
    viewport        TEXT NOT NULL,              -- desktop | tablet | mobile
    repro_steps     JSONB,                      -- ["Step 1: ...", "Step 2: ...", ...]
    console_errors  JSONB,
    network_errors  JSONB,
    screenshot_url  TEXT,                       -- S3 path
    recording_url   TEXT,                       -- S3 path (optional)
    first_seen_at   TIMESTAMPTZ NOT NULL,
    last_seen_at    TIMESTAMPTZ NOT NULL,
    fixed_at        TIMESTAMPTZ,
    snoozed_until   TIMESTAMPTZ,
    snooze_reason   TEXT,
    days_open       INT GENERATED ALWAYS AS (
        EXTRACT(DAY FROM (COALESCE(fixed_at, NOW()) - first_seen_at))
    ) STORED,
    first_crawl_id  UUID REFERENCES crawls(id),
    last_crawl_id   UUID REFERENCES crawls(id),
    jira_ticket_id  TEXT,                       -- linked Jira ticket
    linear_issue_id TEXT,                       -- linked Linear issue
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_bugs_fingerprint ON bugs(project_id, fingerprint)
    WHERE status NOT IN ('false_positive');
CREATE INDEX idx_bugs_project_status ON bugs(project_id, status);
CREATE INDEX idx_bugs_project_severity ON bugs(project_id, severity);
CREATE INDEX idx_bugs_last_seen ON bugs(last_seen_at);

-- CRAWL_BUGS (junction: which bugs were found in which crawl)
CREATE TABLE crawl_bugs (
    crawl_id        UUID REFERENCES crawls(id) ON DELETE CASCADE,
    bug_id          UUID REFERENCES bugs(id) ON DELETE CASCADE,
    PRIMARY KEY (crawl_id, bug_id)
);

-- SITE CONTEXT — Site Graph
CREATE TABLE site_graphs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    version         INT NOT NULL,               -- incremented on change
    pages           JSONB NOT NULL,             -- [{url, type, title, element_count}]
    edges           JSONB NOT NULL,             -- [{from_url, to_url, link_text}]
    page_count      INT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, version)
);

CREATE INDEX idx_site_graphs_project ON site_graphs(project_id, version DESC);

-- SITE CONTEXT — Flow Registry
CREATE TABLE flows (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,              -- "Checkout Flow"
    steps           JSONB NOT NULL,            -- [{url, action, element_selector, description}]
    priority        INT DEFAULT 50,             -- 0=lowest, 100=highest
    requires_auth   BOOLEAN DEFAULT FALSE,
    last_tested_at  TIMESTAMPTZ,
    last_success    BOOLEAN,
    discovery_method TEXT DEFAULT 'auto',       -- auto | manual
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_flows_project ON flows(project_id);

-- SITE CONTEXT — Page Fingerprints
CREATE TABLE page_fingerprints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    page_url        TEXT NOT NULL,
    dom_hash        TEXT NOT NULL,              -- hash of DOM structure (ignoring dynamic content)
    element_count   INT,
    form_count      INT,
    cta_count       INT,
    image_count     INT,
    link_count      INT,
    has_login_form  BOOLEAN DEFAULT FALSE,
    has_search      BOOLEAN DEFAULT FALSE,
    page_type       TEXT,                       -- home | login | signup | product | checkout | settings | other
    crawl_id        UUID REFERENCES crawls(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, page_url, crawl_id)
);

CREATE INDEX idx_fingerprints_project_page ON page_fingerprints(project_id, page_url);

-- DEPLOY EVENTS
CREATE TABLE deploy_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha      TEXT,
    branch          TEXT,
    environment     TEXT DEFAULT 'production',
    source          TEXT DEFAULT 'webhook',     -- webhook | manual
    deployed_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_deploys_project_time ON deploy_events(project_id, deployed_at DESC);

-- INTEGRATIONS (Slack, Jira, etc.)
CREATE TABLE integrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,              -- slack | jira | linear | pagerduty | github
    config          BYTEA NOT NULL,            -- encrypted config (tokens, webhook URLs)
    status          TEXT DEFAULT 'active',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, type)
);

-- NOTIFICATION LOG
CREATE TABLE notification_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,              -- daily_briefing | instant_alert | weekly_summary
    channel         TEXT NOT NULL,              -- email | slack | pagerduty
    recipient       TEXT,
    crawl_id        UUID REFERENCES crawls(id),
    content_hash    TEXT,                       -- to avoid duplicate sends
    sent_at         TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.2 TimescaleDB — Time-Series Tables

```sql
-- Performance metrics per page per crawl
CREATE TABLE perf_metrics (
    time            TIMESTAMPTZ NOT NULL,
    project_id      UUID NOT NULL,
    crawl_id        UUID NOT NULL,
    page_url        TEXT NOT NULL,
    viewport        TEXT NOT NULL,
    load_time_ms    INT,
    ttfb_ms         INT,
    fcp_ms          INT,                        -- First Contentful Paint
    lcp_ms          INT,                        -- Largest Contentful Paint
    cls_score       FLOAT,                      -- Cumulative Layout Shift
    dom_node_count  INT,
    request_count   INT,
    transfer_bytes  BIGINT
);

SELECT create_hypertable('perf_metrics', 'time');

CREATE INDEX idx_perf_project_page ON perf_metrics(project_id, page_url, time DESC);

-- Enable compression for data older than 7 days
ALTER TABLE perf_metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'project_id, page_url, viewport'
);
SELECT add_compression_policy('perf_metrics', INTERVAL '7 days');

-- Health scores over time
CREATE TABLE health_scores (
    time                TIMESTAMPTZ NOT NULL,
    project_id          UUID NOT NULL,
    overall_score       INT NOT NULL,
    functional_score    INT,
    performance_score   INT,
    bug_score           INT,
    accessibility_score INT,
    responsive_score    INT
);

SELECT create_hypertable('health_scores', 'time');
CREATE INDEX idx_health_project ON health_scores(project_id, time DESC);

-- Continuous aggregate for daily average performance
CREATE MATERIALIZED VIEW daily_perf_avg
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time) AS day,
    project_id,
    page_url,
    viewport,
    AVG(load_time_ms)::INT AS avg_load_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms)::INT AS p95_load_ms,
    AVG(lcp_ms)::INT AS avg_lcp_ms,
    AVG(cls_score) AS avg_cls
FROM perf_metrics
GROUP BY day, project_id, page_url, viewport;
```

### 1.3 S3 Object Structure

```
s3://flowlens-data/
├── projects/
│   └── {project_id}/
│       ├── crawls/
│       │   └── {crawl_id}/
│       │       ├── screenshots/
│       │       │   ├── {page_url_hash}_{viewport}.png
│       │       │   └── {page_url_hash}_{viewport}_annotated.png
│       │       ├── recordings/
│       │       │   └── {flow_id}_{viewport}.webm
│       │       ├── har/
│       │       │   └── {page_url_hash}_{viewport}.har
│       │       └── dom/
│       │           └── {page_url_hash}_{viewport}.html
│       └── reports/
│           └── {crawl_id}_report.pdf
└── public-reports/
    └── {report_id}/                              -- free scan reports (publicly accessible)
        ├── summary.json
        └── screenshots/
```

---

## 2. Agent Implementation

### 2.1 Agent Core Loop

```python
class FlowLensAgent:
    """Core agent that crawls a website and detects bugs."""

    def __init__(self, project_config: ProjectConfig, site_context: SiteContext):
        self.config = project_config
        self.context = site_context
        self.planner = FlowPlanner(site_context)
        self.navigator = PageNavigator()
        self.executor = ActionExecutor()
        self.observer = BugObserver()
        self.results = CrawlResults()

    async def run_crawl(self, viewport: Viewport) -> CrawlResults:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport=viewport.dimensions,
                user_agent=viewport.user_agent
            )
            page = await context.new_page()

            # Attach listeners for console errors and network failures
            self._attach_observers(page)

            # Phase 1: Discovery (if site graph is stale or missing)
            if self.context.needs_rediscovery():
                site_graph = await self._discover_site(page)
                self.context.update_graph(site_graph)

            # Phase 2: Plan flows
            flow_plan = await self.planner.create_plan()

            # Phase 3: Execute each flow
            for flow in flow_plan.flows:
                await self._execute_flow(page, flow, viewport)

            await browser.close()
            return self.results

    async def _execute_flow(self, page: Page, flow: Flow, viewport: Viewport):
        """Execute a single user flow, step by step."""
        for step in flow.steps:
            # Navigate to the step's URL if needed
            if page.url != step.url:
                await page.goto(step.url, wait_until='networkidle')

            # OBSERVE: capture current state
            state = await self._observe_page(page, viewport)

            # DETECT: run all bug detectors on current state
            bugs = await self.observer.detect(state)
            self.results.add_bugs(bugs)

            # RECORD: store performance metrics
            metrics = await self._collect_metrics(page)
            self.results.add_metrics(metrics)

            # THINK: decide next action using Navigator
            action = await self.navigator.decide(state, step, self.context)

            if action.type == 'done':
                break

            # ACT: execute the action
            await self.executor.execute(page, action)

            # Wait for page to settle after action
            await page.wait_for_load_state('networkidle', timeout=10000)

    async def _observe_page(self, page: Page, viewport: Viewport) -> PageState:
        """Capture full page state for analysis."""
        return PageState(
            url=page.url,
            viewport=viewport,
            screenshot=await page.screenshot(full_page=True),
            dom=await page.content(),
            accessibility_tree=await page.accessibility.snapshot(),
            console_errors=self._collected_console_errors,
            network_errors=self._collected_network_errors,
            title=await page.title(),
            meta=await self._extract_meta(page)
        )

    async def _collect_metrics(self, page: Page) -> PerformanceMetrics:
        """Collect Web Vitals and performance data."""
        timing = await page.evaluate("""() => {
            const nav = performance.getEntriesByType('navigation')[0];
            const paint = performance.getEntriesByType('paint');
            const fcp = paint.find(p => p.name === 'first-contentful-paint');
            return {
                load_time_ms: Math.round(nav.loadEventEnd - nav.startTime),
                ttfb_ms: Math.round(nav.responseStart - nav.requestStart),
                fcp_ms: fcp ? Math.round(fcp.startTime) : null,
                dom_node_count: document.querySelectorAll('*').length,
                transfer_bytes: nav.transferSize
            };
        }""")
        # LCP and CLS require PerformanceObserver, injected at page load
        lcp = await self._get_lcp(page)
        cls = await self._get_cls(page)

        return PerformanceMetrics(
            page_url=page.url,
            **timing,
            lcp_ms=lcp,
            cls_score=cls,
            request_count=len(self._network_requests)
        )
```

### 2.2 Flow Planner

```python
class FlowPlanner:
    """Decides which flows to test and in what order."""

    def __init__(self, site_context: SiteContext):
        self.context = site_context

    async def create_plan(self) -> FlowPlan:
        # If we have stored flows and site graph hasn't changed, reuse them
        if self.context.has_flows() and not self.context.graph_changed():
            flows = self.context.get_flows()
            return FlowPlan(flows=self._prioritize(flows), source='cached')

        # Otherwise, use LLM to discover flows from the site graph
        flows = await self._discover_flows_with_llm()
        return FlowPlan(flows=self._prioritize(flows), source='discovered')

    async def _discover_flows_with_llm(self) -> list[Flow]:
        """Use LLM to identify logical user flows from the site graph."""
        prompt = f"""Analyze this website's page structure and identify the key user flows.

Site graph:
Pages: {self.context.graph.pages_summary()}
Navigation links: {self.context.graph.edges_summary()}
Page types: {self.context.graph.page_types()}

Identify 5-15 logical user flows. For each flow, provide:
1. A human-readable name (e.g., "Checkout Flow")
2. The ordered sequence of pages
3. Whether it requires authentication
4. Business priority (1-10, where 10 = revenue-critical)

Output as JSON array."""

        response = await llm_client.chat(
            model="claude-sonnet",
            messages=[{"role": "user", "content": prompt}],
            response_format="json"
        )
        return [Flow.from_llm_response(f) for f in response.flows]

    def _prioritize(self, flows: list[Flow]) -> list[Flow]:
        """Sort flows by priority: revenue-critical first."""
        return sorted(flows, key=lambda f: f.priority, reverse=True)
```

### 2.3 Page Navigator

```python
class PageNavigator:
    """Decides what to do on each page using LLM vision."""

    async def decide(
        self,
        state: PageState,
        step: FlowStep,
        context: SiteContext
    ) -> Action:
        """Given the current page state and flow context, decide next action."""

        # Build a condensed representation of the page
        interactive_elements = self._extract_interactive_elements(state.dom)

        prompt = f"""You are testing a website. You are currently on this page:
URL: {state.url}
Page title: {state.title}

You are executing flow step: {step.description}
Goal: {step.expected_action}

Interactive elements on this page:
{self._format_elements(interactive_elements)}

What should I do next? Respond with ONE action:
- click: {{selector: "css_selector", description: "what this does"}}
- type: {{selector: "css_selector", text: "text to type", description: "what field"}}
- scroll: {{direction: "down", amount: 500}}
- navigate: {{url: "target_url"}}
- done: {{reason: "flow step completed"}}

Respond as JSON."""

        response = await llm_client.chat(
            model="claude-sonnet",
            messages=[
                {"role": "user", "content": [
                    {"type": "image", "source": state.screenshot_base64},
                    {"type": "text", "text": prompt}
                ]}
            ],
            response_format="json"
        )

        return Action.from_llm_response(response)

    def _extract_interactive_elements(self, dom: str) -> list[Element]:
        """Parse DOM and extract clickable/typeable elements with selectors."""
        # Uses BeautifulSoup to find: buttons, links, inputs, selects, textareas
        # Returns: [{tag, text, selector, type, name, placeholder, role, aria_label}]
        pass
```

### 2.4 Anti-Loop Mechanisms

```python
class CrawlGuard:
    """Prevents the agent from getting stuck in infinite loops."""

    def __init__(self, max_pages: int = 500, max_depth: int = 10, timeout_seconds: int = 1800):
        self.visited_urls: set[str] = set()
        self.visited_states: set[str] = set()  # hash of URL + DOM structure
        self.action_count: int = 0
        self.max_pages = max_pages
        self.max_depth = max_depth
        self.max_actions = max_pages * 5  # avg 5 actions per page
        self.timeout = timeout_seconds
        self.start_time = time.time()

    def should_continue(self, current_url: str, current_dom_hash: str) -> bool:
        state_key = f"{current_url}:{current_dom_hash}"

        if state_key in self.visited_states:
            return False  # exact same page state seen before

        if len(self.visited_urls) >= self.max_pages:
            return False  # page limit reached

        if self.action_count >= self.max_actions:
            return False  # action limit reached

        if time.time() - self.start_time > self.timeout:
            return False  # timeout

        self.visited_states.add(state_key)
        self.visited_urls.add(current_url)
        self.action_count += 1
        return True

    def normalize_url(self, url: str) -> str:
        """Normalize URL for dedup: remove fragments, sort query params, strip trailing slash."""
        parsed = urlparse(url)
        params = sorted(parse_qs(parsed.query).items())
        normalized = parsed._replace(
            fragment='',
            query=urlencode(params, doseq=True),
            path=parsed.path.rstrip('/')
        )
        return urlunparse(normalized)
```

---

## 3. Bug Detection Algorithms

### 3.1 Functional Detector

```python
class FunctionalDetector:
    """Detects broken links, JS errors, form failures, network errors."""

    async def detect(self, state: PageState) -> list[BugFinding]:
        findings = []

        # 1. Console errors (captured via page.on('console'))
        for error in state.console_errors:
            if error.type in ('error', 'warning'):
                findings.append(BugFinding(
                    category='functional',
                    severity='P2' if error.type == 'warning' else 'P1',
                    title=f'JavaScript {error.type}: {error.text[:100]}',
                    description=error.text,
                    page_url=state.url,
                    evidence={'console_message': error.text, 'stack': error.stack}
                ))

        # 2. Network errors (captured via page.on('response'))
        for req in state.network_errors:
            if req.status >= 400:
                severity = 'P0' if req.status >= 500 else 'P2'
                findings.append(BugFinding(
                    category='functional',
                    severity=severity,
                    title=f'HTTP {req.status} on {req.url_path}',
                    description=f'{req.method} {req.url} returned {req.status}',
                    page_url=state.url,
                    evidence={'request_url': req.url, 'status': req.status, 'method': req.method}
                ))

        # 3. Broken images
        broken_images = await self._check_images(state)
        findings.extend(broken_images)

        return findings
```

### 3.2 Responsive Detector

```python
class ResponsiveDetector:
    """Detects mobile/tablet-specific layout issues."""

    async def detect(self, state: PageState) -> list[BugFinding]:
        findings = []

        if state.viewport.type != 'mobile':
            return findings

        # 1. Horizontal overflow (page wider than viewport)
        has_overflow = await state.page.evaluate("""() => {
            return document.documentElement.scrollWidth > document.documentElement.clientWidth;
        }""")
        if has_overflow:
            findings.append(BugFinding(
                category='responsive',
                severity='P2',
                title='Horizontal scroll detected on mobile',
                description='Page content extends beyond the viewport width, causing unwanted horizontal scrolling.',
                page_url=state.url
            ))

        # 2. Touch targets too small (< 44x44px per WCAG)
        small_targets = await state.page.evaluate("""() => {
            const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');
            const small = [];
            for (const el of interactive) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
                    small.push({
                        tag: el.tagName,
                        text: el.textContent?.trim().substring(0, 50),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    });
                }
            }
            return small;
        }""")
        if len(small_targets) > 3:  # don't flag if only 1-2 minor elements
            findings.append(BugFinding(
                category='responsive',
                severity='P3',
                title=f'{len(small_targets)} touch targets below 44x44px',
                description='Interactive elements are too small for comfortable touch interaction on mobile.',
                page_url=state.url,
                evidence={'elements': small_targets[:10]}
            ))

        # 3. Text too small (< 16px on mobile)
        # 4. Fixed elements blocking content
        # 5. Viewport meta tag missing or incorrect

        return findings
```

### 3.3 Performance Detector

```python
class PerformanceDetector:
    """Detects slow pages, large assets, and Web Vitals issues."""

    THRESHOLDS = {
        'load_time_ms': {'warning': 3000, 'critical': 5000},
        'lcp_ms': {'warning': 2500, 'critical': 4000},
        'cls_score': {'warning': 0.1, 'critical': 0.25},
        'fcp_ms': {'warning': 1800, 'critical': 3000},
    }

    async def detect(self, state: PageState, metrics: PerformanceMetrics, baseline: PerformanceBaseline | None) -> list[BugFinding]:
        findings = []

        # 1. Absolute threshold checks
        for metric_name, thresholds in self.THRESHOLDS.items():
            value = getattr(metrics, metric_name)
            if value is None:
                continue
            if value > thresholds['critical']:
                findings.append(BugFinding(
                    category='performance',
                    severity='P1',
                    title=f'Critical: {metric_name} is {value}ms (threshold: {thresholds["critical"]}ms)',
                    page_url=state.url,
                    evidence={'metric': metric_name, 'value': value, 'threshold': thresholds['critical']}
                ))
            elif value > thresholds['warning']:
                findings.append(BugFinding(
                    category='performance',
                    severity='P2',
                    title=f'{metric_name} is {value}ms (warning threshold: {thresholds["warning"]}ms)',
                    page_url=state.url,
                    evidence={'metric': metric_name, 'value': value, 'threshold': thresholds['warning']}
                ))

        # 2. Regression check against baseline (if available)
        if baseline:
            for metric_name in ['load_time_ms', 'lcp_ms']:
                value = getattr(metrics, metric_name)
                if value is None:
                    continue
                z_score = (value - baseline.mean(metric_name)) / max(baseline.stddev(metric_name), 1)
                if z_score > 2.0:  # more than 2 standard deviations above baseline
                    pct_change = ((value - baseline.mean(metric_name)) / baseline.mean(metric_name)) * 100
                    findings.append(BugFinding(
                        category='performance',
                        severity='P1' if z_score > 3.0 else 'P2',
                        title=f'{metric_name} regressed {pct_change:.0f}% from baseline',
                        description=f'Current: {value}ms, Baseline avg: {baseline.mean(metric_name):.0f}ms (z-score: {z_score:.1f})',
                        page_url=state.url,
                        evidence={'metric': metric_name, 'current': value, 'baseline_avg': baseline.mean(metric_name), 'z_score': z_score}
                    ))

        return findings
```

### 3.4 Accessibility Detector

```python
class AccessibilityDetector:
    """Runs axe-core and custom ARIA checks."""

    async def detect(self, state: PageState) -> list[BugFinding]:
        # Inject and run axe-core
        await state.page.evaluate(AXE_CORE_SCRIPT)
        axe_results = await state.page.evaluate("() => axe.run()")

        findings = []
        severity_map = {
            'critical': 'P1',
            'serious': 'P2',
            'moderate': 'P3',
            'minor': 'P4'
        }

        for violation in axe_results.get('violations', []):
            findings.append(BugFinding(
                category='accessibility',
                severity=severity_map.get(violation['impact'], 'P3'),
                title=f'A11y: {violation["help"]}',
                description=violation.get('description', ''),
                page_url=state.url,
                evidence={
                    'rule_id': violation['id'],
                    'impact': violation['impact'],
                    'nodes_affected': len(violation.get('nodes', [])),
                    'help_url': violation.get('helpUrl')
                }
            ))

        return findings
```

---

## 4. Analytics Algorithms

### 4.1 Bug Fingerprinting

The fingerprint algorithm must produce the same hash for the "same" bug across crawls, even if minor details change.

```python
def compute_fingerprint(bug: BugFinding) -> str:
    """Generate a stable fingerprint for bug deduplication across crawls.

    The fingerprint is based on:
    - The page URL (normalized: no query params, no fragments)
    - The bug category
    - The bug's "identity" (varies by category)

    This means: if two crawls find the same type of bug on the same page,
    they produce the same fingerprint, and we know it's the same bug.
    """
    page_normalized = normalize_url(bug.page_url)

    if bug.category == 'functional' and 'status' in bug.evidence:
        # Network errors: fingerprint on URL + status code
        identity = f"{bug.evidence.get('request_url', '')}:{bug.evidence.get('status', '')}"
    elif bug.category == 'functional' and 'console_message' in bug.evidence:
        # Console errors: fingerprint on first line of error message
        identity = bug.evidence['console_message'].split('\n')[0][:200]
    elif bug.category == 'accessibility':
        # A11y: fingerprint on rule ID
        identity = bug.evidence.get('rule_id', bug.title)
    elif bug.category == 'responsive':
        # Responsive: fingerprint on issue type
        identity = bug.title.split(':')[0] if ':' in bug.title else bug.title
    elif bug.category == 'performance':
        # Performance: fingerprint on metric name
        identity = bug.evidence.get('metric', bug.title)
    else:
        # Fallback: fingerprint on title
        identity = bug.title

    raw = f"{page_normalized}|{bug.category}|{bug.viewport}|{identity}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]
```

### 4.2 Diff Engine

```python
class DiffEngine:
    """Compares two crawls and produces a structured diff."""

    def compute_diff(
        self,
        current_bugs: list[Bug],
        previous_bugs: list[Bug],
        current_metrics: dict[str, PerformanceMetrics],
        previous_metrics: dict[str, PerformanceMetrics]
    ) -> CrawlDiff:

        current_fps = {b.fingerprint for b in current_bugs if b.status == 'open'}
        previous_fps = {b.fingerprint for b in previous_bugs if b.status == 'open'}

        new_fps = current_fps - previous_fps
        fixed_fps = previous_fps - current_fps
        persistent_fps = current_fps & previous_fps

        new_bugs = [b for b in current_bugs if b.fingerprint in new_fps]
        fixed_bugs = [b for b in previous_bugs if b.fingerprint in fixed_fps]
        persistent_bugs = [b for b in current_bugs if b.fingerprint in persistent_fps]

        # Performance diffs
        perf_changes = []
        for page_url in set(current_metrics.keys()) | set(previous_metrics.keys()):
            curr = current_metrics.get(page_url)
            prev = previous_metrics.get(page_url)
            if curr and prev:
                delta = curr.load_time_ms - prev.load_time_ms
                pct = (delta / max(prev.load_time_ms, 1)) * 100
                if abs(pct) > 20:  # only flag changes > 20%
                    perf_changes.append(PerfChange(
                        page_url=page_url,
                        metric='load_time_ms',
                        previous=prev.load_time_ms,
                        current=curr.load_time_ms,
                        delta_ms=delta,
                        delta_pct=pct
                    ))

        return CrawlDiff(
            new_bugs=new_bugs,
            fixed_bugs=fixed_bugs,
            persistent_bugs=persistent_bugs,
            perf_changes=sorted(perf_changes, key=lambda p: abs(p.delta_pct), reverse=True)
        )
```

### 4.3 Health Score Calculator

```python
class HealthScoreCalculator:
    """Computes a composite site health score (0-100)."""

    WEIGHTS = {
        'functional': 0.40,
        'performance': 0.25,
        'bugs': 0.20,
        'accessibility': 0.10,
        'responsive': 0.05
    }

    def calculate(
        self,
        flows_tested: int,
        flows_passed: int,
        active_bugs: list[Bug],
        avg_load_time_ms: float,
        a11y_violations: int,
        mobile_bugs: int,
        total_bugs: int
    ) -> HealthScore:

        # Functional: what % of flows pass without errors?
        functional = (flows_passed / max(flows_tested, 1)) * 100

        # Performance: how do load times compare to targets?
        # < 2s = 100, 2-3s = linear 100->50, 3-5s = linear 50->0, > 5s = 0
        if avg_load_time_ms <= 2000:
            performance = 100
        elif avg_load_time_ms <= 3000:
            performance = 100 - ((avg_load_time_ms - 2000) / 1000) * 50
        elif avg_load_time_ms <= 5000:
            performance = 50 - ((avg_load_time_ms - 3000) / 2000) * 50
        else:
            performance = 0

        # Bugs: weighted penalty by severity
        severity_weights = {'P0': 25, 'P1': 15, 'P2': 8, 'P3': 3, 'P4': 1}
        bug_penalty = sum(severity_weights.get(b.severity, 1) for b in active_bugs)
        bugs = max(100 - bug_penalty, 0)

        # Accessibility: diminishing penalty per violation
        a11y = max(100 - (a11y_violations * 3), 0)

        # Responsive: penalty for mobile-specific bugs
        mobile_ratio = mobile_bugs / max(total_bugs, 1)
        responsive = max(100 - (mobile_ratio * 100), 0)

        overall = (
            functional * self.WEIGHTS['functional'] +
            performance * self.WEIGHTS['performance'] +
            bugs * self.WEIGHTS['bugs'] +
            a11y * self.WEIGHTS['accessibility'] +
            responsive * self.WEIGHTS['responsive']
        )

        return HealthScore(
            overall=round(overall),
            functional=round(functional),
            performance=round(performance),
            bug_score=round(bugs),
            accessibility=round(a11y),
            responsive=round(responsive)
        )
```

---

## 5. API Contracts

### 5.1 Core Endpoints

```
Authentication: Bearer token (Clerk JWT)
Base URL: /api/v1

PROJECTS
  POST   /projects                              Create project
  GET    /projects                              List user's projects
  GET    /projects/:id                          Get project details
  PATCH  /projects/:id                          Update project settings
  DELETE /projects/:id                          Delete project

CRAWLS
  POST   /projects/:id/crawls                   Trigger manual crawl
  GET    /projects/:id/crawls                   List crawl history
  GET    /projects/:id/crawls/:crawlId          Get crawl details + summary
  GET    /projects/:id/crawls/:crawlId/diff     Get diff with previous crawl
  GET    /projects/:id/crawls/latest            Get most recent crawl

BUGS
  GET    /projects/:id/bugs                     List bugs (filterable)
  GET    /projects/:id/bugs/:bugId              Get bug detail + evidence
  PATCH  /projects/:id/bugs/:bugId              Update bug (snooze, false_positive)
  POST   /projects/:id/bugs/:bugId/ticket       Create Jira/Linear ticket from bug

TRENDS
  GET    /projects/:id/trends/health            Health score over time
  GET    /projects/:id/trends/performance       Per-page performance over time
  GET    /projects/:id/trends/bugs              Bug count by severity over time
  GET    /projects/:id/trends/flows             Flow success rates over time

SITE CONTEXT
  GET    /projects/:id/context/graph            Current site graph
  GET    /projects/:id/context/flows            Discovered flows
  GET    /projects/:id/context/fingerprints     Page fingerprints

WEBHOOKS (incoming)
  POST   /webhooks/deploy                       Receive deploy event from CI/CD
  POST   /webhooks/clerk                        Receive user events from Clerk

INTEGRATIONS
  POST   /projects/:id/integrations             Configure integration
  GET    /projects/:id/integrations             List integrations
  DELETE /projects/:id/integrations/:type       Remove integration
  POST   /projects/:id/integrations/:type/test  Test integration (send test message)

FREE SCAN (no auth)
  POST   /scan                                  Start free scan (rate-limited)
  GET    /scan/:reportId                        Get free scan report
  GET    /scan/:reportId/status                 Poll scan status (SSE)
```

### 5.2 Key Request/Response Schemas

```python
# POST /api/v1/projects
class CreateProjectRequest(BaseModel):
    name: str
    url: HttpUrl
    crawl_schedule: Literal['daily', 'hourly', 'weekly'] = 'daily'
    crawl_time: str = '02:00'  # HH:MM in user timezone
    viewports: list[Literal['desktop', 'tablet', 'mobile']] = ['desktop', 'mobile']

class ProjectResponse(BaseModel):
    id: str
    name: str
    url: str
    status: str
    crawl_schedule: str
    latest_health_score: int | None
    latest_crawl_at: datetime | None
    active_bug_count: int
    created_at: datetime

# GET /api/v1/projects/:id/bugs?status=open&severity=P0,P1&page=1&limit=20
class BugListResponse(BaseModel):
    bugs: list[BugSummary]
    total: int
    page: int
    has_more: bool

class BugSummary(BaseModel):
    id: str
    severity: str
    category: str
    title: str
    page_url: str
    viewport: str
    status: str
    days_open: int
    first_seen_at: datetime
    last_seen_at: datetime
    screenshot_url: str | None
    jira_ticket_id: str | None

# GET /api/v1/projects/:id/trends/health?period=30d
class HealthTrendResponse(BaseModel):
    data_points: list[HealthDataPoint]
    period: str
    current_score: int
    period_change: int  # delta over the period

class HealthDataPoint(BaseModel):
    date: date
    overall: int
    functional: int
    performance: int
    bug_score: int
    accessibility: int
    responsive: int
    deploy_event: DeployEvent | None  # if a deploy happened on this date

# GET /api/v1/projects/:id/crawls/:crawlId/diff
class CrawlDiffResponse(BaseModel):
    crawl_id: str
    previous_crawl_id: str
    new_bugs: list[BugSummary]
    fixed_bugs: list[BugSummary]
    persistent_bugs: list[BugSummary]
    perf_changes: list[PerfChangeItem]
    health_score: int
    health_delta: int
    pages_tested: int
    flows_tested: int
```

---

## 6. Notification System

### 6.1 Daily Briefing Generation

```python
class BriefingGenerator:
    """Generates the daily briefing using LLM for natural language."""

    async def generate(self, project: Project, crawl_diff: CrawlDiff, health: HealthScore) -> Briefing:

        # Structured data for the LLM
        context = {
            "site_name": project.name,
            "site_url": project.url,
            "health_score": health.overall,
            "health_delta": crawl_diff.health_delta,
            "new_bugs": [{"severity": b.severity, "title": b.title, "page": b.page_url, "viewport": b.viewport} for b in crawl_diff.new_bugs],
            "fixed_bugs": [{"severity": b.severity, "title": b.title} for b in crawl_diff.fixed_bugs],
            "persistent_bugs": [{"severity": b.severity, "title": b.title, "days_open": b.days_open} for b in crawl_diff.persistent_bugs if b.days_open >= 7],
            "perf_changes": [{"page": p.page_url, "previous_ms": p.previous, "current_ms": p.current, "change_pct": p.delta_pct} for p in crawl_diff.perf_changes],
            "pages_tested": crawl_diff.pages_tested,
            "flows_tested": crawl_diff.flows_tested
        }

        prompt = f"""Write a daily QA briefing for {project.name}. 
You are a friendly, competent QA team member reporting to the engineering team.

Tone: warm, direct, conversational. Like a Slack message from a colleague.
Use "I" language: "I tested...", "I found...", "I noticed..."
Be concise. Highlight what CHANGED since yesterday.
For persistent bugs, note how many days they've been open — create gentle urgency.
For performance changes, explain direction and magnitude clearly.

Data:
{json.dumps(context, indent=2)}

Write the briefing as plain text (not markdown). Keep it under 300 words."""

        briefing_text = await llm_client.chat(
            model="claude-haiku",  # fast + cheap for text generation
            messages=[{"role": "user", "content": prompt}]
        )

        return Briefing(
            project_id=project.id,
            text=briefing_text,
            health_score=health.overall,
            new_bug_count=len(crawl_diff.new_bugs),
            fixed_bug_count=len(crawl_diff.fixed_bugs)
        )
```

### 6.2 Alert Routing

```python
class AlertRouter:
    """Routes notifications to the right channel based on severity and config."""

    async def route(self, project: Project, crawl_diff: CrawlDiff):
        # P0 bugs: INSTANT alert, all channels
        for bug in crawl_diff.new_bugs:
            if bug.severity == 'P0':
                await self._send_instant_alert(project, bug)

        # Daily briefing: scheduled for user's configured time
        # (handled by the scheduler, not inline here)

    async def _send_instant_alert(self, project: Project, bug: Bug):
        integrations = await self._get_integrations(project.id)

        alert = InstantAlert(
            title=f"CRITICAL: {bug.title}",
            description=bug.description,
            page_url=bug.page_url,
            viewport=bug.viewport,
            screenshot_url=bug.screenshot_url,
            evidence_url=f"https://app.flowlens.com/project/{project.id}/bugs/{bug.id}"
        )

        tasks = []
        if 'slack' in integrations:
            tasks.append(self._send_slack(integrations['slack'], alert))
        if 'pagerduty' in integrations:
            tasks.append(self._send_pagerduty(integrations['pagerduty'], alert))

        # Always send email to project owner
        tasks.append(self._send_email(project.owner_email, alert))

        await asyncio.gather(*tasks)
```

---

## 7. LLM Integration

### 7.1 LLM Client Abstraction

```python
class LLMClient:
    """Abstraction over multiple LLM providers with fallback."""

    def __init__(self):
        self.primary = AnthropicClient()
        self.fallback = OpenAIClient()

    async def chat(
        self,
        model: str,
        messages: list[dict],
        response_format: str = "text",
        max_tokens: int = 2000,
        temperature: float = 0.1
    ) -> str:
        model_map = {
            "claude-sonnet": ("anthropic", "claude-sonnet-4-20250514"),
            "claude-haiku": ("anthropic", "claude-haiku-4-20250414"),
            "gpt4o": ("openai", "gpt-4o"),
        }

        provider, model_id = model_map.get(model, ("anthropic", model))

        try:
            if provider == "anthropic":
                return await self.primary.chat(model_id, messages, max_tokens, temperature)
            else:
                return await self.fallback.chat(model_id, messages, max_tokens, temperature)
        except Exception:
            # Fallback to other provider
            if provider == "anthropic":
                return await self.fallback.chat("gpt-4o", messages, max_tokens, temperature)
            else:
                return await self.primary.chat("claude-sonnet-4-20250514", messages, max_tokens, temperature)
```

### 7.2 LLM Cost Optimization

```python
class LLMCostOptimizer:
    """Minimizes LLM usage by using cached context and tiered models."""

    async def should_use_vision(self, page_url: str, current_dom_hash: str, context: SiteContext) -> bool:
        """Only use expensive vision model if the page looks different from last crawl."""
        previous_hash = context.get_fingerprint(page_url)
        if previous_hash and previous_hash.dom_hash == current_dom_hash:
            return False  # page unchanged, skip vision
        return True

    def select_model(self, task: str) -> str:
        """Use the cheapest model that can handle the task."""
        model_tiers = {
            'flow_planning': 'claude-sonnet',       # complex reasoning, runs once per crawl
            'page_navigation': 'claude-sonnet',      # needs vision, runs per page
            'page_navigation_simple': 'claude-haiku', # simple pages, no complex forms
            'bug_description': 'claude-haiku',       # text generation, fast
            'briefing_generation': 'claude-haiku',   # text generation, fast
            'visual_bug_detection': 'claude-sonnet',  # needs vision + reasoning
        }
        return model_tiers.get(task, 'claude-haiku')
```

---

*End of Low Level Design document.*
