# ChainLens RPC/API Usage Audit

**Audit date:** 2026-05-21  
**Scope:** All server/client code paths that call Alchemy, Base RPC, GoldRush/Covalent, GeckoTerminal, Zerion, GoPlus, Honeypot.is, CoinGecko, and ENSData.  
**Goal:** Identify root causes of elevated Alchemy request usage observed around May 19.

---

## 1. Inventory of All External API Calls

### 1.1 Wallet Scanner — `lib/server/walletSnapshot.ts` + `app/api/wallet/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| `alchemy_getAssetTransfers` (ETH sent) | Alchemy ETH | Wallet scan | 1× per scan | None | 6 s | Plan-gated (wallet API) | HIGH |
| `alchemy_getAssetTransfers` (ETH received) | Alchemy ETH | Wallet scan | 1× per scan | None | 6 s | Plan-gated | HIGH |
| `alchemy_getAssetTransfers` (Base sent) | Alchemy Base | Wallet scan | 1× per scan | None | 6 s | Plan-gated | HIGH |
| `alchemy_getAssetTransfers` (Base received) | Alchemy Base | Wallet scan | 1× per scan | None | 6 s | Plan-gated | HIGH |
| `eth_getTransactionCount` (ETH nonce) | Alchemy ETH | Wallet scan | 1× per scan | None | 6 s | Plan-gated | MEDIUM |
| `eth_getTransactionCount` (Base nonce) | Alchemy Base | Wallet scan | 1× per scan | None | 6 s | Plan-gated | MEDIUM |
| Zerion positions | Zerion | Wallet scan | 1× per scan | None | varies | Plan-gated | MEDIUM |
| Zerion portfolio | Zerion | Wallet scan | 1× per scan | None | varies | Plan-gated | MEDIUM |
| GoldRush ETH balances | GoldRush | Wallet scan | 1× per scan | None | varies | Plan-gated | MEDIUM |
| GoldRush Base balances | GoldRush | Wallet scan | 1× per scan | None | varies | Plan-gated | MEDIUM |
| GoldRush ETH PnL events | GoldRush | Wallet scan | 1× per scan | None | varies | Plan-gated | MEDIUM |
| GoldRush Base PnL events | GoldRush | Wallet scan | 1× per scan | None | varies | Plan-gated | MEDIUM |

**Cache:** `/api/wallet` has a 3-minute in-memory TTL cache keyed by lowercase address. `/api/portfolio` also has 3-minute cache. Both use `Map` (reset on cold start).  
**Total Alchemy calls per wallet scan:** ~6 (4× `alchemy_getAssetTransfers` + 2× `eth_getTransactionCount`).  
**Note:** `fetchWalletSnapshot` is called by both `/api/wallet` and `/api/portfolio`. If a user opens both features for the same wallet within 3 minutes, the cache hits. If server restarts (cold start), the cache is empty and every user triggers a fresh scan.

**Recommended fix:** Add persistent Redis/KV cache layer, or increase in-memory TTL to 10 minutes for authenticated users.

---

### 1.2 Whale Alerts On-Chain Enrichment — `app/api/whale-alerts/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| `eth_getBalance` per wallet | Alchemy Base | 30 s client poll → on-chain enrich | Up to 20× per request | 4 min per wallet | 3 s per wallet | None | CRITICAL |
| `eth_getTransactionCount` per wallet | Alchemy Base | 30 s client poll → on-chain enrich | Up to 20× per request | 4 min per wallet | 3 s per wallet | None | CRITICAL |
| `eth_getCode` per wallet | Alchemy Base | 30 s client poll → on-chain enrich | Up to 20× per request | 4 min per wallet | 3 s per wallet | None | CRITICAL |
| GeckoTerminal price per token | GeckoTerminal | 30 s client poll | Up to 15 random tokens | 45 s response cache | 8 s | None server-side | HIGH |
| Supabase alert queries | Supabase | 30 s client poll | 4 parallel queries | None | None | None | LOW |

**Cache strategy:**
- Response cache (`whaleCache`): 45-second TTL keyed by query params
- On-chain wallet cache (`onChainCache`): 4-minute TTL
- Behavior history cache (`behaviorHistCache`): 4-minute TTL

**Worst case per 30-second cycle (no cache):**  
20 wallets × 3 Alchemy calls = **60 Alchemy calls** per tick per active user tab.  
With 10 concurrent users: **600 Alchemy calls per 30 seconds = 1,200/minute**.

**Why the cache may not protect:** Each unique set of alert query parameters (`window`, `interesting`, `valueRange`, `limit`) generates a separate `whaleCache` entry. Wallets rotate as new alerts arrive, invalidating the `onChainCache` for new addresses.

**Recommended fix:** Cap the number of wallets enriched per request to 5 (currently 20). Increase `onChainCache` TTL to 10 minutes. Add a server-side rate limit on the enrichment loop.

---

### 1.3 Whale Alerts Sync — `app/api/whale-alerts/sync/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GoldRush transactions per wallet | GoldRush/Covalent | Manual sync click | Up to 8 concurrent | None | 6 s per wallet | Pro=60 s cooldown, Elite=30 s | MEDIUM |

**Concurrency:** `CONCURRENCY = 8`, `MAX_LIMIT = 10` wallets per batch.  
**Safety timeout:** 19.5 s overall.  
**Rate limited by plan:** Pro 60 s cooldown, Elite 30 s, Dev 10 s.

---

### 1.4 Token Scanner — `app/api/token/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GoldRush token holders | GoldRush | Scan click | 1× per scan | 5 min | 10 s | 15 req/min | MEDIUM |
| GoldRush pool data | GoldRush | Scan click | 1× per scan | 5 min | 10 s | 15 req/min | MEDIUM |
| GoldRush LP holders | GoldRush | Scan click | 1× per scan | 5 min | 10 s | 15 req/min | MEDIUM |
| Honeypot.is simulation | Honeypot.is | Scan click | 1× per scan | 5 min | 10 s | 15 req/min | LOW |
| GoPlus token security | GoPlus | Scan click | 1× per scan | 5 min | 10 s | 15 req/min | LOW |
| GeckoTerminal pool data | GeckoTerminal | Scan click | 1× per scan | 5 min (coingeckoCache) | 10 s | 15 req/min | LOW |

**No Alchemy calls** in token scanner backend.  
**Cache:** 5-minute in-memory TTL per contract address.  
**Rate limit:** 15 req/min per IP.

---

### 1.5 Scan Holder — `app/api/scan-holder/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| `eth_getCode` (contract bytecode) | Alchemy Base | LP Control panel click | 1× per address | **No cache** | varies | 15 req/min | MEDIUM |

**Note:** No caching on this route. Each unique address triggers a fresh `eth_getCode` Alchemy call. Repeated analysis of the same contract (e.g., during a scan session) hits Alchemy each time.

**Recommended fix:** Add a short in-memory cache (10-minute TTL keyed by address). Contract bytecode is immutable once deployed.

---

### 1.6 Clark AI — `app/api/clark/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GoldRush (Covalent) token/pool data | GoldRush | Token analysis query | 1-2× per query | 60-90 s clark cache | 9 s | Clark response rate limit | HIGH |
| Zerion positions | Zerion | Wallet analysis query | 1-2× per query | 60-90 s clark cache | varies | Clark response rate limit | HIGH |
| Covalent wallet transactions | Covalent | Wallet analysis query | 1-2× per query | 60-90 s clark cache | 9 s | Clark response rate limit | HIGH |
| GeckoTerminal pool search | GeckoTerminal | Token name search | 1× per query | 60-90 s clark cache | 8 s | Clark response rate limit | MEDIUM |
| CoinGecko majors price | CoinGecko | Market overview query | 1× **no cache** | **No cache** | varies | Clark response rate limit | HIGH |
| ENSData resolver | ENSData | ENS/Basename in prompt | 1× per name | None | 4.5 s | Clark response rate limit | LOW |
| Honeypot.is via `fetchHoneypotSecurity` | Honeypot.is | Token analysis query | 1× per query | 60-90 s clark cache | varies | Clark response rate limit | MEDIUM |
| Anthropic Claude (intent routing) | Anthropic | Every Clark message | 1× per message | None | varies | Clark plan rate limit | HIGH |
| Anthropic Claude (response) | Anthropic | Every Clark message | 1× per message | 60-90 s clark cache | varies | Clark plan rate limit | HIGH |
| Internal `/api/pump-alerts` | Self | Market/pump query | 1× per query | 90 s pump cache | 4-5 s | Inherited | MEDIUM |
| Internal `/api/trending` | Self | Market overview | 1× per query | 60 s GT / 120 s CG | 5.5 s | Inherited | LOW |
| Internal `/api/scan-token` | Self | Token query via Clark | 1× per query | 60 s coingeckoCache | 9 s | Inherited | MEDIUM |
| Internal `/api/whale-alerts` | Self | Whale feed query | 1-2× per query | 45 s whaleCache | 5 s | Inherited | HIGH |

**Clark cache key:** `JSON.stringify({ actor, verifiedPlan, feature, mode, prompt, chain, token, wallet })`.  
Any variation in prompt text (even whitespace) generates a new cache key. The cache does NOT deduplicate semantically equivalent queries.

**CoinGecko majors warning:** `fetchCoinGeckoMajors` has **no cache** and is called on market overview queries. Each request hits CoinGecko directly.

**Alchemy exposure via Clark wallet mode:** When Clark handles a wallet query, it calls `fetchWalletSnapshot`, which triggers all 6+ Alchemy calls described in §1.1.

---

### 1.7 Base Radar — `app/api/radar/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GeckoTerminal new Base pools | GeckoTerminal | Page load + 60 s auto-refresh | 1× per cycle | 60 s (coingeckoCache) | 6 s | 5 req/min | MEDIUM |
| Honeypot.is (top 10 pools) | Honeypot.is | Page load + 60 s auto-refresh | Up to 10× per cycle | **No cache** | 5 s each | 5 req/min | HIGH |
| Anthropic Claude (verdicts, top 5) | Anthropic | Page load + 60 s auto-refresh | 1× per cycle | Clark cache key (60-120 s) | varies | 5 req/min | HIGH |

**Auto-refresh:** Every 60 seconds for each active Base Radar tab.  
**Honeypot.is calls:** Up to 10 per refresh cycle, with no in-route caching. If GT data varies between calls (new pool in pool 1-10), previously-checked tokens are re-checked from scratch.

**Recommended fix:** Cache Honeypot.is results by contract address for at least 5 minutes.

---

### 1.8 Pump Alerts — `app/api/pump-alerts/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GeckoTerminal pools (up to 3 pages) | GeckoTerminal | Page load + 60 s auto-refresh | 3× per miss | 90 s cache by plan | varies | None server-side | MEDIUM |

**Cache:** 90-second TTL keyed by plan (`pump:free`, `pump:pro`, `pump:elite`).  
**Auto-refresh:** Client-side 60s countdown trigger.

---

### 1.9 Trending — `app/api/trending/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GeckoTerminal Base pools (page 1) | GeckoTerminal | Dashboard live page (30 s poll) | 1× per miss | 60 s (coingeckoCache) | 5 s | None | LOW |
| CoinGecko trending | CoinGecko | Dashboard live page (30 s poll) | 1× per miss | 120 s (coingeckoCache) | varies | None | LOW |

**Client polling:** `app/dashboard/live/page.tsx` polls every 30 seconds.

---

### 1.10 Liquidity Safety — `app/api/liquidity-safety/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GeckoTerminal pool data (2 calls) | GeckoTerminal | LP Control panel click | 2× per scan | 3 min liqCache | 7-8 s | Plan + cooldown | MEDIUM |
| GoPlus token security | GoPlus | LP Control panel click | 1× per scan | 3 min liqCache | 8 s | Plan + cooldown | LOW |
| GoPlus LP lock data | GoPlus | LP Control panel click | 1× per scan | 3 min liqCache | 8 s | Plan + cooldown | LOW |

**Plan-gated:** Pro+ only.  
**Rate limit:** Per-plan cooldown (stored in-memory map).

---

### 1.11 GoPlus — `app/api/goplus/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GoPlus access token | GoPlus | Each GoPlus request (if credentialed) | 1× | None | varies | 20 req/min | LOW |
| GoPlus token security | GoPlus | Via scan-token, liquidity-safety, Clark | 1× | None in route | None | 20 req/min | MEDIUM |

**Note:** No caching in `/api/goplus`. Callers (e.g., `scan-token`) provide their own cache via `coingeckoCache`.

---

### 1.12 Portfolio — `app/api/portfolio/route.ts`

| Endpoint / File | Provider | Trigger | Req Multiplier | Cache | Timeout | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| Full `fetchWalletSnapshot` | Alchemy + GoldRush + Zerion | Portfolio page "Load Portfolio" click | Same as §1.1 | 3 min | 30 s total | None | HIGH |

**Manual trigger only** — user must click "Load Portfolio".  
**Same Alchemy footprint as wallet scan** (~6 Alchemy calls per load).

---

### 1.13 Client-Side Polling Summary

| Page | Interval | API Called | Alchemy Exposure |
|---|---|---|---|
| `app/terminal/whale-alerts/page.tsx` | 30 s | `/api/whale-alerts` | Up to 60 Alchemy calls per tick (via enrichment) |
| `app/dashboard/live/page.tsx` | 30 s | `/api/trending` | None |
| `app/terminal/base-radar/page.tsx` | 60 s | `/api/radar` | None (Honeypot.is, not Alchemy) |
| `app/terminal/pump-alerts/page.tsx` | 60 s | `/api/pump-alerts` | None |
| `app/terminal/portfolio/page.tsx` | 500 ms | Cooldown timer only (no API) | None |

---

## 2. Top 5 Likely Causes of the May 19 Alchemy Spike

### #1 — CRITICAL: Whale Alerts On-Chain Enrichment (Up to 60 Alchemy calls/30 s per user)

**File:** `app/api/whale-alerts/route.ts`  
**Root cause:** Every 30 seconds, each active Whale Alerts tab triggers a server request that may enrich up to 20 unique wallet addresses with 3 Alchemy RPC calls each (`eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`). The `onChainCache` is keyed by address with a 4-minute TTL, but as new whale alerts arrive with new wallet addresses, new Alchemy calls are issued.

If 10 users had the Whale Alerts page open on May 19:  
`10 users × 20 wallets × 3 calls = 600 Alchemy calls per 30 s → 1,200/min`.

**Compounding factor:** The `whaleCache` (45-second TTL) is keyed by full query params. Users with different filter settings (`window`, `valueRange`, `limit`) each get their own enrichment batch.

---

### #2 — HIGH: Wallet Scanner Cold Start / Cache Miss Cascade

**File:** `lib/server/walletSnapshot.ts`, `app/api/wallet/route.ts`  
**Root cause:** The 3-minute in-memory wallet cache resets on every server restart or cold start (Vercel serverless functions). If May 19 coincided with a deployment, cache flush, or traffic spike that caused function scale-out, every user's wallet scan would trigger 6+ fresh Alchemy calls simultaneously.

A single deployment creating 5 new serverless instances, each receiving 10 wallet scans with empty caches:  
`5 instances × 10 scans × 6 Alchemy calls = 300 Alchemy calls in the first 3 minutes`.

---

### #3 — HIGH: Clark Wallet Analysis Bypassing Wallet Cache

**File:** `app/api/clark/route.ts` — wallet analysis path  
**Root cause:** When a user asks Clark to analyze a wallet address, Clark calls `fetchWalletSnapshot` directly via the internal wallet data fetcher. This may be a separate code path from `/api/wallet/route.ts` and may not share the same in-memory cache. If so, Clark wallet queries each trigger a full 6+ Alchemy call stack independent of the wallet cache.

The Clark response cache (90-second TTL) is keyed on the full prompt string. A user asking "analyze 0x..." then "what's 0x...'s first tx" gets two separate Clark cache entries, potentially triggering two full wallet scans.

---

### #4 — MEDIUM: Scan Holder No-Cache Bytecode Calls

**File:** `app/api/scan-holder/route.ts`  
**Root cause:** `eth_getCode` is called on every request with no caching. Contract bytecode is immutable — the same result will be returned for the same address forever. If the LP Control panel re-requests the same address on each user interaction (e.g., on every tab switch or panel open), Alchemy is called each time.

At 15 req/min rate limit, a single heavy user can generate 15 Alchemy calls per minute from this route alone.

---

### #5 — MEDIUM: Base Radar Honeypot Checks Without Caching

**File:** `app/api/radar/route.ts`  
**Root cause:** Up to 10 Honeypot.is checks fire in parallel on every Base Radar refresh (60-second cycle). While Honeypot.is is not Alchemy, if GeckoTerminal data identifies pools containing tokens that were previously analyzed, the same contracts are re-checked every 60 seconds with no result caching. This doesn't directly consume Alchemy credits but may have masked a concurrent Alchemy spike in monitoring.

Additionally, if Clark is invoked after Base Radar loads (users clicking into tokens), each Clark token analysis adds GoldRush + GeckoTerminal + GoPlus + Honeypot calls on top.

---

## 3. Quick Wins (Safe to Implement Without Separate Prompts)

| Fix | File | Change | Alchemy Impact |
|---|---|---|---|
| Cache `eth_getCode` results | `app/api/scan-holder/route.ts` | Add 10-min in-memory Map cache keyed by address | Eliminates repeat Alchemy calls for same contract |
| Cache Honeypot.is results in Radar | `app/api/radar/route.ts` | Add 5-min Map cache keyed by contract address | No Alchemy impact; reduces Honeypot.is load |
| Cache `fetchCoinGeckoMajors` in Clark | `app/api/clark/route.ts` | Wrap in 60-second in-memory cache | No Alchemy; reduces CoinGecko calls |

---

## 4. Fixes That Need a Separate Prompt

| Fix | File | Why Separate |
|---|---|---|
| Cap whale alert enrichment to 5 wallets | `app/api/whale-alerts/route.ts` | Requires product decision on enrichment depth |
| Increase whale alert `onChainCache` TTL to 10 min | `app/api/whale-alerts/route.ts` | May cause staleness for whale behavior tracking |
| Share wallet snapshot cache between `/api/wallet` and Clark wallet path | `lib/server/walletSnapshot.ts`, `app/api/clark/route.ts` | Architecture change — requires auditing Clark fetch paths |
| Add Redis/KV persistent cache for wallet snapshots | `lib/server/walletSnapshot.ts` | Infrastructure change |
| Deduplicate Clark cache keys semantically | `app/api/clark/route.ts` | Requires NLP or prompt normalization logic |
| Rate-limit `/api/whale-alerts` server-side by IP | `app/api/whale-alerts/route.ts` | Need to determine appropriate limit per plan |

---

## 5. Should ETH/SOL Expansion Wait?

**Recommendation: Yes, defer ETH and SOL chain expansion.**

**Reasoning:**

1. **Wallet scanner already runs on ETH mainnet.** `getFirstTxOnChain` is called for both ETH and Base, doubling Alchemy ETH calls per scan. Adding a third chain (SOL would require a different provider, ETH expansion of token scanner would add GoldRush ETH calls).

2. **The May 19 spike was not caused by chain coverage** but by polling frequency (whale alerts) and cache volatility (serverless restarts). Expanding chains before fixing these multipliers means any spike is multiplied by the number of chains.

3. **Fix the enrichment cap and cache persistence first.** Once the wallet cache persists across cold starts and the whale alert enrichment is capped at 5 wallets per tick, the per-request Alchemy cost drops significantly and chain expansion becomes predictable to budget.

4. **GoldRush ETH already configured.** The `GOLDRUSH_CHAIN` map in `clark/route.ts` includes `ethereum: "eth-mainnet"`. If Clark is already issuing ETH GoldRush calls for wallet analysis (check whether Ethereum chain is enabled for wallets), this may be contributing to API usage beyond Base.

**Hold ETH/SOL expansion until:**
- Whale alert enrichment cap is in place
- Wallet snapshot cache survives serverless cold starts
- Alchemy usage baseline is stable for ≥1 week

---

## 6. Files Responsible for Highest Alchemy Usage

1. `app/api/whale-alerts/route.ts` — Up to 60 Alchemy calls per 30-second tick
2. `lib/server/walletSnapshot.ts` — ~6 Alchemy calls per wallet scan (cache-miss driven)
3. `app/api/clark/route.ts` — Wallet analysis mode triggers full wallet snapshot stack
4. `app/api/scan-holder/route.ts` — 1 uncached Alchemy call per LP analysis request
5. `app/api/wallet/route.ts` + `app/api/portfolio/route.ts` — Thin wrappers over walletSnapshot; both share cache keyed by address

---

*Audit completed. No provider names were added to any public-facing UI. No API keys are exposed in this document. No code changes were made beyond creating this file.*
