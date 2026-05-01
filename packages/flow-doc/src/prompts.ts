/**
 * Prompts. Kept inline (not in a separate `prompts/*.md`) because OpenAI
 * structured-output calls are most reliable when the system prompt and
 * schema definition live next to each other in code.
 *
 * If we later want hot-reloadable prompts we can move these into Postgres
 * (`org_prompt_overrides` table) without touching the call sites.
 */

export const NARRATE_SYSTEM_PROMPT = `You convert one recorded user action on a website into a semantic test step.

Inputs you'll receive:
- The previous and current screenshots (post-action).
- The action type (click, input, change, submit, keypress, navigate, scroll).
- The page URL + title.
- The recorded value, if the action was an input/change.
- A best-effort hardened-selector hint.

You must output strict JSON matching the schema. Be concrete and concise.

Field guide:
- intent: imperative description of what the user is trying to accomplish in this step. Max one sentence.
- expectedOutcome: what should be visible / what should be true after the step. Max one sentence.
- isCritical: true if this step is on the critical path (data submission, navigation to a different page, irreversible action). False for cosmetic steps like dismissing a banner or scrolling.
- fragility: low | medium | high. Heuristic: low = stable testid + clear role + clear name. Medium = decent CSS selector. High = the element is identified mostly by visual appearance.

Don't speculate beyond what the screenshots show. Don't include any preamble.`;

export const SYNTHESIZE_SYSTEM_PROMPT = `You synthesize a recorded user flow into a Flow Document for automated testing.

Inputs:
- The site origin.
- An optional cached site model (high-level understanding of the site).
- An optional page screenshot showing the application surface the user recorded against.
  Use it to understand what kind of page this is (filter / form / dashboard / table / login / checkout / etc.) and to ground the flow's purpose in what's actually visible.
- An optional inventory of ALL form controls visible on the page at recording end, each tagged (touched) or (NOT touched). Untouched controls expand the flow's scope: mention them in preconditions / postconditions / fragilityHints when they relate to the recorded interaction.
- A list of narrated steps with intent + expected outcome + criticality. Each step may also carry controlType / controlName / availableOptions / recordedValue — use these to be specific about what was changed (e.g. "Filters the table to Java courses by selecting the Language radio").

Output strict JSON.

Field guide:
- name: short imperative title (e.g. "Sign up and verify email"). Max ~60 chars. Be specific to the recorded interaction.
- description: one or two sentences describing the flow's purpose, grounded in the screenshot + control inventory + recorded values. Avoid generic phrases like "filters and sorts a table" — be concrete: "Filters the Automation Courses table to Java + Advanced and sorts by Enrollments descending".
- preconditions: any state that must be true before the flow runs (e.g. "user is logged out", "cart is empty"). Include relevant initial values of UNTOUCHED controls when they affect the result (e.g. "Min enrollments is unfiltered" if visible in the screenshot).
- postconditions: state that must be true after the flow runs successfully — what the user should observe in the screenshot AFTER the flow.
- fragilityHints: 0-5 short notes on likely failure modes (e.g. "cart counter selector changes between A/B variants", "Sort dropdown options may be re-ordered between releases").
- stepRevisions: only include indices where you'd improve on the per-step narration. Most flows need 0-3 revisions. When the per-step intent is generic (e.g. "click on https://...") and you can do better from the screenshot + control metadata, revise it.

Don't speculate beyond what the screenshot, controls, and step narrations show. Don't include any preamble. Strict JSON only.`;

export const SIBLINGS_SYSTEM_PROMPT = `You suggest sibling test flows (negative paths and adjacent variants) after a user records one happy-path flow.

Goal: each sibling tests something the recorded flow does NOT, but on the same site/feature surface. The user will run these autonomously — no recording needed.

Output strict JSON with up to 3 flows. Each entry:
- name: short imperative title.
- description: one-sentence description.
- task: the natural-language task the replay agent will receive. Be specific enough that an autonomous agent can execute it from cold without a recording. Include test data hints (e.g. "use email already-registered@flowlens.example for the duplicate-email case").
- rationale: 1 sentence on why this sibling is valuable.

Examples of good siblings:
- For a "Sign up" recording: "Sign up with already-used email" (duplicate path), "Sign up with weak password" (validation), "Resend verification email".
- For a "Checkout" recording: "Checkout with invalid card", "Apply discount code", "Guest checkout (no auth)".
- For a "Search" recording: "Search with no results", "Search with very long query".

Don't include preamble. Strict JSON only.`;

export const SENSITIVE_SYSTEM_PROMPT = `You classify whether a form field is sensitive (should never have its raw value stored in a Flow Document).

Strict JSON. Be conservative — when in doubt, mark sensitive. False positives are fine; a missed sensitive field is a privacy bug.`;
