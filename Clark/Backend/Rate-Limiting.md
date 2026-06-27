# Backend — Rate Limiting

**Source:** `lib/server/rateLimit.ts` (~lines 94–96)

## Limits by plan

| Plan | Requests/day | Requests/min | Low-cost requests/min |
|---|---|---|---|
| Free | 5 | 2 | 15 |
| Pro | 50 | 5 | 20 |
| Elite | 300 | 5 | 20 |

## Implementation

Simple in-memory bucket store tracking `resetAt`/`count` per user, created via `createRateLimiter()`. This is per-process state, not a distributed store — relevant if ChainLens ever runs multiple server instances, since limits would not be shared across instances.

## Relationship to capabilities

Rate limiting is applied at the request layer, before intent routing ([[Intent-Routing]]) or any capability handler runs. It is plan-aware but not intent-aware — a token scan and a follow-up question consume the same bucket.
