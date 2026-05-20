# @flowlens/bu-cloud-client

Typed client for the Browser Use Cloud v2 REST API.

## Usage

```ts
import { createBuClient } from '@flowlens/bu-cloud-client';

const bu = createBuClient(); // reads BROWSER_USE_API_KEY from env

// Hybrid replay: create a hosted browser, attach our cookie profile,
// drive it via cdp_url with browser-use locally.
const session = await bu.createBrowserSession({
  profileId: flow.buProfileId,
  proxyCountryCode: 'in',
  keepAlive: true,
});

console.log('CDP URL:', session.cdpUrl);
console.log('Live URL:', session.liveUrl);

// ... do replay work over CDP ...

await bu.stopBrowserSession(session.id);
```

## Env vars

| Var | Required | Notes |
|---|---|---|
| `BROWSER_USE_API_KEY` | yes | Generated at https://cloud.browser-use.com/new-api-key |

## Notes

- All errors throw `BuCloudError` with `.status` and `.body`.
- `BuCloudError` exposes `.isRateLimited` (HTTP 429) and `.isInsufficientBalance` (HTTP 402).
- v2 API is the canonical version (v1 is deprecated and used only in older browser-use examples).
- The replay-agent LLM is **OpenAI** via `browser_use.ChatOpenAI` (model from `apps/web/src/lib/models.ts`). `ChatBrowserUse` is an opt-in fallback for cost-sensitive orgs.
