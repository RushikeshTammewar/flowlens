# @flowlens/flow-doc

Recording → Flow Document compile pipeline. Imported by `apps/web` route handlers.

## Surface

```ts
import { compileRecording } from '@flowlens/flow-doc';

const result = await compileRecording({
	flowId,
	siteOrigin: 'https://shop.example.com',
	siteModelText: null,
	actions, // RecordedAction[]
	resolveScreenshotUrl: async ({ actionIndex }) => {
		const blobKey = `recordings/${flowId}/screenshots/${actionIndex}.webp`;
		return signedBlobUrl(blobKey);
	},
	progress: (e) => emitSse(flowId, { type: 'compile_progress', flowId, ...e }),
});
// result.steps: FlowStep[]
// result.synthesis: name, description, preconditions, ...
// result.siblings: 0-3 AI-suggested follow-up flows
// result.llmTokensUsed: total tokens across all stages
// result.llmCostUsdMicroEstimate: per-org cost accounting
```

## Stages

1. **Normalize** — drop scroll-only and duplicate-click noise; re-index actions.
2. **Narrate** — `gpt-4.1-mini` vision call per action, parallel ×4. Outputs `intent`, `expectedOutcome`, `isCritical`, `fragility`.
3. **Synthesize** — single `gpt-4.1` call producing the Flow document (name, description, pre/postconditions, fragility hints, optional per-step revisions).
4. **Siblings** — `gpt-4.1-mini` produces up to 3 sibling flows for opt-in. Best-effort: failures here never block the compile.

## LLM hardening

Every call goes through `structured.ts` which uses OpenAI v6's native
`zodResponseFormat` helper. There is no JSON parsing in this package — if
a response can't be schema-coerced, the call throws.

## Cost accounting

`compileRecording` returns `llmCostUsdMicroEstimate` in microdollars,
suitable for adding to `runs.cost_usd_micro` / org credit accounting.
Pricing tables are inline in `compile.ts`; bump them whenever OpenAI
changes a price.
