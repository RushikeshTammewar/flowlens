# @flowlens/llm-config

Centralized model selection AND provider routing for every LLM call in
Flowlens v3.

## Why this exists

Two unrelated concerns collapsed into one package:

1. **Model selection.** Every stage (narrate, judge, matrix-generator, …)
   has a recommended model that can be overridden per-environment.
2. **Provider routing.** As of April 2026 the same call can hit OpenAI
   directly (api.openai.com, $2K of direct credit) or Azure AI Foundry
   ($10K of Azure credit, broader catalog including GPT-5, o3/o4 family,
   DeepSeek-R1, Phi-4, etc.).

Both decisions live behind one import surface so call sites never branch on
provider:

```ts
import { getLlmClient, modelFor } from '@flowlens/llm-config';

const client = getLlmClient();           // OpenAI OR AzureOpenAI (drop-in)
const r = await client.chat.completions.create({
  model: modelFor('narrate'),            // 'gpt-4.1-mini' on OpenAI,
                                         // 'gpt-5-mini' deployment on Azure
  messages: [...]
});
```

## Provider routing

Set `LLM_PROVIDER` in `.env.local`:

```bash
LLM_PROVIDER=openai           # default: hits api.openai.com
LLM_PROVIDER=azure_foundry    # routes every call to Azure AI Foundry
```

When `LLM_PROVIDER=azure_foundry`, you must also set:

```bash
AZURE_FOUNDRY_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
AZURE_FOUNDRY_API_KEY=<resource API key from Foundry Studio>
# Optional:
AZURE_FOUNDRY_API_VERSION=2024-12-01-preview
```

The `/api/projects/<project>` suffix on the endpoint is the Foundry
**control-plane** path. The package strips it before building inference
URLs (the data plane lives at `<resource>/openai/deployments/...`). Either
form of `AZURE_FOUNDRY_ENDPOINT` works.

Implementation: `getLlmClient()` returns a singleton `OpenAI` instance for
OpenAI mode and an `AzureOpenAI` instance (which extends `OpenAI`) for
Azure mode. All call sites that use `client.chat.completions.create()` or
`client.chat.completions.parse()` work unchanged.

## Model table

The table below shows the default model/deployment per stage on each
provider. **On Azure, the value is the DEPLOYMENT NAME you create in
Foundry Studio** — by convention we name deployments after the model id so
the same string works as both a deployment name and a checklist.

| Stage                     | OpenAI default      | Azure deployment    |
|---------------------------|---------------------|---------------------|
| `narrate`                 | `gpt-4.1-mini`      | `gpt-5-mini`        |
| `synthesize`              | `gpt-4.1`           | `gpt-5`             |
| `replayAgent`             | `gpt-4.1-mini`      | `gpt-5-mini`        |
| `judge`                   | `gpt-4.1-mini`      | `gpt-5-mini`        |
| `investigator`            | `o4-mini`           | `gpt-5`             |
| `siteModel`               | `gpt-4.1`           | `gpt-5`             |
| `dataGen`                 | `gpt-4.1-mini`      | `gpt-5-mini`        |
| `siblingGen`              | `gpt-4.1-mini`      | `gpt-5-mini`        |
| `driftAnalyzer`           | `gpt-4.1`           | `gpt-5`             |
| `sensitiveClassifier`     | `gpt-4.1-mini`      | `gpt-5-mini`        |
| `matrixGenerator`         | `o3`                | `gpt-5`             |
| `matrixGeneratorFallback` | `o4-mini`           | `gpt-5-mini`        |
| `matrixCluster`           | `o4-mini`           | `gpt-5-mini`        |

### Required deployments in Foundry Studio

To run with `LLM_PROVIDER=azure_foundry` and the defaults above, create
these deployments in **Foundry Studio → Deployments → Deploy a base model**:

1. **`gpt-5`** — variant generation, synthesize, investigator, site model,
   drift analyzer.
2. **`gpt-5-mini`** — narration, judge, replay agent, data gen, sibling
   gen, sensitive classifier, matrix cluster.

Both are needed; everything else is optional. If a deployment is not yet
provisioned, override that stage to a deployment you do have:

```bash
FLOWLENS_MODEL_MATRIX_GENERATOR=gpt-5-mini   # use mini until gpt-5 is provisioned
```

The deployment-creation URL is in your Foundry portal:
`https://ai.azure.com/build/deployments?wsid=/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<resource>/projects/<project>`

## Per-stage env overrides

Every stage has a canonical override key
`FLOWLENS_MODEL_<CAMEL_TO_SCREAMING_SNAKE>`:

```bash
FLOWLENS_MODEL_NARRATE=gpt-5-nano             # Azure deployment name
FLOWLENS_MODEL_SYNTHESIZE=gpt-5
FLOWLENS_MODEL_MATRIX_GENERATOR=o3            # OpenAI model id
FLOWLENS_MODEL_MATRIX_GENERATOR_FALLBACK=o4-mini
```

Three legacy aliases are still accepted for back-compat with existing
`.env` files (will be removed in a future major):

| Canonical                                  | Legacy alias               |
|--------------------------------------------|----------------------------|
| `FLOWLENS_MODEL_DRIFT_ANALYZER`            | `FLOWLENS_MODEL_DRIFT`     |
| `FLOWLENS_MODEL_SENSITIVE_CLASSIFIER`      | `FLOWLENS_MODEL_SENSITIVE` |
| `FLOWLENS_MODEL_MATRIX_GENERATOR_FALLBACK` | `FLOWLENS_MODEL_MATRIX_FALLBACK` |

The override is applied verbatim — if you set
`FLOWLENS_MODEL_JUDGE=gpt-4.1-mini` while running with
`LLM_PROVIDER=azure_foundry`, the call will go to a Foundry deployment
named exactly `gpt-4.1-mini`, NOT to OpenAI. Be intentional with overrides
when flipping providers.

> **Migration tip:** when flipping `LLM_PROVIDER=openai` →
> `LLM_PROVIDER=azure_foundry`, REMOVE all your `FLOWLENS_MODEL_*`
> overrides (or rename their values to your Foundry deployment names).
> Otherwise the override pins the call to a name that may not exist as a
> deployment.

## Smoke test

```bash
cd apps/web
./node_modules/.bin/tsx scripts/foundry-smoke.mjs
```

Output is JSON with both providers' resolved model, latency, and either
`reply: "OK"` (success) or `error` + `status` (failure). Use this to
validate your `.env.local` after creating new deployments.

## Python mirror

`apps/replay-worker/app/llm_client.py` mirrors this same registry,
provider routing, and override behavior. Keep both in sync — the worker
reads its own copy because the TS package can't be imported into Python.

## Public surface

```ts
import {
  // Routing
  getProvider,        // 'openai' | 'azure'
  getLlmClient,       // OpenAI-compatible client for active provider
  hasLlmCredentials,  // env-presence check (used by /api/health)

  // Model selection
  MODELS,             // Proxy: MODELS.narrate → resolves at access-time
  modelFor,           // modelFor('narrate') → string
  modelTableSnapshot, // { narrate: '...', judge: '...', ... }

  // Types
  type LlmProvider,
  type ModelKey,
  type ModelName,
} from '@flowlens/llm-config';
```
