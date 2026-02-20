# FlowLens

**Your AI QA Engineer. Always On. Always Watching.**

FlowLens is a continuous website quality monitoring service. Give it a URL and it becomes your dedicated QA team member — testing every flow on your site every day, tracking bugs over time, detecting regressions, and delivering a morning briefing of what changed.

It costs $120K-$200K/year to hire a QA engineer. FlowLens does the same job for a fraction of that.

---

## How It Works

```
1. Paste your website URL
2. FlowLens's AI agent explores every user flow like a human
3. It detects bugs, performance issues, accessibility problems, and responsive breakage
4. Every day, it crawls your site again and tells you what changed
5. You wake up to a morning briefing: new bugs, fixed bugs, performance shifts
```

No scripts. No prompts. No maintenance. Just a URL and you're guarded.

---

## What Makes It Different

- **Zero config** — autonomous flow discovery. No test scripts needed.
- **Continuous monitoring** — daily crawls, not one-time scans.
- **Historical intelligence** — tracks bugs over time. Knows when they appeared, how long they've been open, and when they got fixed.
- **Site Context** — builds a persistent knowledge base about your website that gets smarter with every crawl.
- **Regression detection** — statistically significant performance changes, correlated with deploys.
- **Human-like briefings** — morning reports that read like a message from a colleague.

---

## Documentation

| Document | Description |
|---|---|
| [Business Case Study](docs/BUSINESS_CASE_STUDY.md) | Market analysis, competitors, TAM, ROI, go-to-market strategy |
| [High Level Design](docs/HIGH_LEVEL_DESIGN.md) | System architecture, component design, data flow, tech stack, UX design, Site Context model |
| [Low Level Design](docs/LOW_LEVEL_DESIGN.md) | Database schemas, agent algorithms, bug detection, analytics, API contracts, LLM integration |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, Tailwind CSS, Radix UI, Recharts, React Flow |
| Backend | Python FastAPI, SQLAlchemy, Temporal.io |
| Agent | Python, Playwright, Claude API (Anthropic) |
| Database | PostgreSQL + TimescaleDB |
| Storage | AWS S3 |
| Cache | Redis |
| Auth | Clerk |
| Infra | Railway (MVP) / AWS ECS (scale) |

---

## Project Structure

```
flowlens/
├── README.md
├── docs/
│   ├── BUSINESS_CASE_STUDY.md
│   ├── HIGH_LEVEL_DESIGN.md
│   └── LOW_LEVEL_DESIGN.md
├── agent/          # AI browser agent (Python)
├── analytics/      # Diff engine, trends, health score
├── backend/        # FastAPI server
├── frontend/       # Next.js dashboard
└── infra/          # Docker, deployment configs
```

---

## Status

**Ideation + Design phase.** Architecture and design documents complete. Implementation next.

---

*Created: February 2026*
*Author: Rushikesh Tammewar*
