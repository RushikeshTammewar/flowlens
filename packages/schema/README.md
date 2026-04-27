# @flowlens/schema

Shared Zod runtime schemas + Drizzle ORM table definitions for Flowlens v3.

Imported by:

- `apps/extension` — for type-safe API client + runtime message validation
- `apps/web` — for API route handlers and Drizzle queries
- `packages/replay-engine` — for `Flow`, `FlowStep`, `Run`, `StepResult`
- `packages/flow-doc` — for compile output validation
- `packages/cookies-vault` — for `ChromeCookie`, `CookieSnapshot`

## Layout

| File | Contents |
|---|---|
| `flow.ts` | Flow + FlowStep + HardenedSelectors + sensitive-detection enums |
| `run.ts` | Run + StepResult + verdict types |
| `recording.ts` | RecordedAction + RecordingFinishPayload |
| `cookie.ts` | ChromeCookie + StorageSnapshot + CookieSnapshot |
| `events.ts` | SseEvent + ExtensionMessage discriminated unions |
| `db.ts` | Drizzle table definitions (Postgres) |

## Usage

```ts
import { FlowSchema, type Flow } from '@flowlens/schema';
import { flows, runs } from '@flowlens/schema/db';

const parsed = FlowSchema.parse(input);
const allFlows = await db.select().from(flows).where(eq(flows.orgId, orgId));
```
