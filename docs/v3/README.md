# Flowlens v3 — Design Documents

> **Status:** proposed (plan mode draft, 2026-04-27)

Three documents describe the v3 architecture in increasing depth.


| Doc                  | Audience                 | Contents                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[HLD.md](HLD.md)** | Anyone (PM, eng, exec)   | Vision, end-to-end user journey, system architecture diagram, components, tech stack & rationale, key design decisions, phased delivery, cost model, risks                                                                                                                                                     |
| **[LLD.md](LLD.md)** | Engineers ready to build | Component map, full Drizzle schema, every API endpoint, recording protocol, replay engine algorithm with pseudo-code, every LLM call mapped, cookie vault design, edge cases (recording / auth / replay), execution traces for 5 scenarios, performance budgets, detailed cost model, security & observability |
| **[UX.md](UX.md)**   | Designers + frontend eng | Design principles, information architecture, persona journey maps, extension state machine, ASCII wireframes for every state of every screen (extension + web), microinteractions, empty states, error states, accessibility, microcopy, Figma handoff plan                                                    |


## TL;DR (the 60-second pitch)

A user installs the Flowlens Chrome extension. They click "Record" while doing their normal task on any website. We capture a structured recording (rrweb DOM events + per-action screenshots + cookies + storage), turn it into a semantic Flow document with an LLM, and replay it on demand on Browser Use Cloud. Each replay is an LLM-driven agent that *thinks* through every step — using the recording as a strong prior, not a script — and verifies both correctness (intent succeeded) and regression (visual diff, Pro tier). Cookies expire? The extension shows a banner; the user logs in once on the real site; we capture fresh cookies and resume the paused run. Reports live in the extension (summary) and on a web dashboard (full detail, public share, run history).

## Key technology choices

- **Browser Use Cloud** as the only browser runtime ($500 credits granted)
- **WXT** for the MV3 extension
- **Next.js 16** + Vercel for everything else (web, API, durable workflows, cron)
- **Neon Postgres** + **Vercel Blob** + **Upstash Redis**
- **Clerk** for auth
- **OpenAI** is the sole LLM provider — `gpt-4.1-mini` (narration / replay agent / judge / data gen / sibling gen), `gpt-4.1` (flow synthesis / site model / drift), `o4-mini` (failure investigator). All model strings centralized in `apps/web/src/lib/models.ts`.
- **ChatBrowserUse** is an opt-in fallback for the replay agent only (cheaper provider-side caching, less control).

## What's coming next

This is a plan-mode draft. Execution begins after sign-off. Phased delivery in [HLD §10](HLD.md#10-phased-delivery-4-weeks):

1. **Week 1** — Foundations (Vercel + DB + auth + empty extension)
2. **Week 2** — Recording → Flow document pipeline
3. **Week 3** — LLM-first replay + auth refresh
4. **Week 4** — Web dashboard, regression diffing, Chrome Store, EC2 decommission

