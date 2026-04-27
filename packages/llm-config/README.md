# @flowlens/llm-config

Centralized model selection for every LLM call in Flowlens v3.

## Why a separate package

`apps/web/src/lib/openai.ts` (server-only OpenAI client) and `packages/flow-doc` (compile pipeline) both need to read the same `MODELS` constant. Originally `models.ts` lived in `apps/web/src/lib/` but `flow-doc` is a `packages/` workspace and can't reach into `apps/`. Moving the registry here keeps the package graph DAG-shaped.

## Usage

```ts
import { MODELS } from '@flowlens/llm-config';
import OpenAI from 'openai';

const res = await openai.chat.completions.create({
  model: MODELS.narrate,           // 'gpt-4.1-mini' by default
  messages: [...]
});
```

## Override per environment

Every entry has a `FLOWLENS_MODEL_*` env var override (see `.env.example`).

## Python mirror

`apps/replay-worker/src/flowlens_worker/models.py` mirrors this same registry. Keep them in sync — the worker reads its own copy because the TS package can't be imported into Python.
