# Alchemy / RPC Usage Audit
**Date:** 2026-05-23  
**Scope:** All terminal pages + API routes + lib/server helpers  
**Goal:** Identify provider calls that fire automatically on page load without user action

---

## Findings Table

| File | Route / Page | Trigger | Provider / RPC | Auto on page-load? | Est. calls/load | Cache? | Timeout? | Risk | Fix |
|---|---|---|---|---|---|---|---|---|---|
| `app/api/whale-alerts/route.ts` | `/api/whale-alerts` | Whale Alerts page mount (`useEffect`) | Alchemy RPC: `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode` batch | **YES** | ≤15 CUs (5 wallets × 3 methods) → fixed to ≤9 (3 × 3) | Yes, 4 min → **8 min** | Yes, 5s | **CRITICAL** | Reduce `MAX_ENRICHED_WALLETS` 5→3, increase `ONCHAIN_TTL_MS` 4→8 min ✅ |
| `app/api/test/alchemy/route.ts` | `/api/test/alchemy` | Public GET endpoint, no auth | Alchemy: `eth_blockNumber` | On every GET request with no guard | 1 CU/request (unlimited in prod) | None | None → **5s added** | **CRITICAL** | Block in production behind `x-admin-secret`, add rate limit ✅ |
| `app/terminal/base-radar/page.tsx` | `/terminal/base-radar` | Page mount + 60s auto-refresh → `/api/radar` | GeckoTerminal (new pools) + honeypot.is + Anthropic Claude | **YES** (mount + every 60s) | 0 Alchemy, but ~5 honeypot.is + 1 Claude call per auto-cycle | Yes (coingeckoCache, honeypotCache) | Yes, 8s | **HIGH** (Claude/API cost) | Increase refresh 60s → **120s** ✅ |
| `app/terminal/pump-alerts/page.tsx` | `/terminal/pump-alerts` | Page mount + 60s auto-refresh → `/api/pump-alerts` | GeckoTerminal pools (via `getOrFetchCached`) | **YES** (mount + every 60s) | 0 Alchemy, GeckoTerminal + coingecko cache | Yes (90s cache) | Yes, via cache wrapper | **MEDIUM** | Increase refresh 60s → **120s** ✅ |
| `app/terminal/whale-alerts/page.tsx` | `/terminal/whale-alerts` | Page mount via `useEffect(() => { void loadAlerts() }, [loadAlerts])` | Calls `/api/whale-alerts` which enriches wallets via Alchemy RPC | **YES** | Covered by whale-alerts route fix above | — | — | **HIGH** | Handled by route-level fix |
| `app/terminal/token-scanner/page.tsx` | `/terminal/token-scanner` | URL param `?contract=` triggers `handleScan()` on mount | Alchemy + GeckoTerminal via `/api/token` (eth_call, LP analysis) | Only if `?contract=` present | Heavy (multiple eth_call for LP/security) | Yes, 3 min | Yes, 5s per call | **MEDIUM** | Intentional deep link. No change — single shot, guarded by scan cache |
| `app/terminal/clark-ai/page.tsx` | `/terminal/clark-ai` | Page mount → `/api/user-settings` | Supabase auth check (no Alchemy) | YES | 1 DB call | No (user settings are per-session) | No | **LOW** | Not Alchemy — acceptable |
| `app/api/wallet/route.ts` | `/api/wallet` | Wallet Scanner scan button (user action) | Alchemy via `walletSnapshot.ts` (`alchemy_getAssetTransfers`) | **NO** | 2-4 Alchemy Transfer calls | Yes, 3 min | Yes, 8s | **LOW** | User-triggered. No change. |
| `lib/server/walletSnapshot.ts` | Called by `/api/wallet` | User-triggered scan | Alchemy: `alchemy_getAssetTransfers` (eth + base), `eth_getTransactionCount` | NO | 2-4 calls per scan | Yes, 5 min (snapshot), 15 min (history) | Yes, 8s | **LOW** | Already well-guarded. Cache TTL is appropriate. |
| `app/api/dev-wallet/route.ts` | `/api/dev-wallet` | User action (Clark or Dev Wallet page) | Alchemy: `alchemy_getAssetTransfers`, `eth_getCode`, `eth_getTransactionReceipt` | **NO** | 2-5 calls per scan | Yes, 3 min (devs), 7 days (creators) | Yes, 8s | **LOW** | User-triggered. Creator cache TTL is excellent (7 days). |
| `app/api/token/route.ts` | `/api/token` | Token Scanner scan button (user action) | Multiple `eth_call` for LP/security analysis | **NO** | 8-15+ eth_call per scan | Yes, 3 min | Yes, 5s per call | **LOW** | User-triggered. Well-cached. |
| `app/api/scan-holder/route.ts` | `/api/scan-holder` | Token scan (user action) | `eth_getCode` (Base) | **NO** | 1 per unique contract | Yes, 10 min | No explicit | **LOW** | Add AbortSignal.timeout (minor) |
| `app/terminal/portfolio/page.tsx` | `/terminal/portfolio` | Scan Portfolio button (user action) | Via `/api/portfolio` → walletSnapshot | **NO** | 0 on page load | — | — | **LOW** | Correct behavior. |
| `app/terminal/wallet-scanner/page.tsx` | `/terminal/wallet-scanner` | Scan button (user action) | Via `/api/wallet` → Alchemy | **NO** | 0 on page load | — | — | **LOW** | Correct behavior. |
| `app/terminal/dev-wallet/page.tsx` | `/terminal/dev-wallet` | Analyze button (user action) | Via `/api/dev-wallet` → Alchemy | **NO** | 0 on page load | — | — | **LOW** | Correct behavior. |

---

## Top 5 Alchemy Waste Sources

| Rank | Source | CUs/event | Frequency | Fix |
|---|---|---|---|---|
| 1 | **Whale Alerts page auto-load** | Up to 15 CUs (5 wallets × 3 RPC batch) per cold load | Every page open, server restart resets cache | Reduced to 9 CUs max (3 wallets × 3 RPC); cache TTL doubled to 8 min ✅ |
| 2 | **`/api/test/alchemy` public endpoint** | 1 CU per request, no auth | Unlimited (bot-accessible) | Blocked in production behind admin secret ✅ |
| 3 | **Token Scanner via URL param** | 8-15 eth_call per scan | Each deep link open | Single-shot, 3-min cache. Acceptable. No change. |
| 4 | **Dev Wallet analysis** (Clark AI context) | 2-5 alchemy_getAssetTransfers calls | When user asks "who deployed this" in Clark | 7-day creator cache. Excellent. No change. |
| 5 | **Wallet Snapshot** (Wallet Scanner + Portfolio) | 2-4 alchemy_getAssetTransfers calls | Each manual scan | 5-min cache. User-triggered. No change. |

---

## Changes Made

### 1. `app/api/whale-alerts/route.ts`
- `ONCHAIN_TTL_MS`: 4 min → **8 min** (doubles cache hit rate for on-chain wallet data)
- `CONTRACT_TTL_MS`: 10 min → **20 min** (contracts don't change, safe to cache longer)
- `MAX_ENRICHED_WALLETS`: 5 → **3** (cuts max Alchemy CUs per cold load from 15 to 9, -40%)
- `RPC_BUDGET`: 15 → **9** (consistent with new max)
- `FETCH_CONCURRENCY`: 3 → **2** (reduces burst RPC pressure)

### 2. `app/api/test/alchemy/route.ts`
- **Blocked in production** behind `x-admin-secret` header check
- Added per-IP rate limit: 3 requests/minute
- Added 5s `AbortSignal.timeout`
- Added key-present check before calling Alchemy

### 3. `app/terminal/base-radar/page.tsx`
- Auto-refresh interval: **60s → 120s**
- Halves Claude API + honeypot.is calls from Base Radar auto-refresh
- No functional change (same data, less frequent auto-call)

### 4. `app/terminal/pump-alerts/page.tsx`
- Auto-refresh interval: **60s → 120s**
- Halves GeckoTerminal pool polling from Pump Alerts auto-refresh
- Has 90s server-side cache so 120s client interval makes the cache more effective

---

## Behavior Changes

| Feature | Before | After |
|---|---|---|
| Whale Alerts page load | Up to 15 Alchemy CUs per cold load | Up to 9 Alchemy CUs per cold load (-40%) |
| Whale Alerts on-chain cache | 4 min TTL | 8 min TTL (2× cache lifetime) |
| `/api/test/alchemy` | Public, unlimited | Production-blocked; 3/min rate limit in dev |
| Base Radar auto-refresh | Every 60s | Every **120s** (-50% API calls) |
| Pump Alerts auto-refresh | Every 60s | Every **120s** (-50% API calls) |

---

## No Changes (Correct Behavior)

- **Wallet Scanner**: User presses Scan → action-gated ✅
- **Portfolio**: User presses Scan Portfolio → action-gated ✅
- **Token Scanner**: User presses Scan Token → action-gated ✅ (URL param = intentional deep link)
- **Dev Wallet**: User presses Analyze → action-gated ✅
- **Clark AI**: `/api/user-settings` on mount fetches Supabase auth (not Alchemy) ✅

---

## Expected CU Reduction

Assuming 100 daily active users opening Whale Alerts:
- Before: 100 × 15 CUs (cold) = **1,500 Alchemy CUs/day** from page loads alone
- After: 100 × 9 CUs (cold), with 2× cache effectiveness → roughly **~500-600 CUs/day** (-60-67%)

Base Radar + Pump Alerts interval doubling reduces external API calls by 50% for those features, though neither uses Alchemy directly.

---

## Build Result

`✓ Compiled successfully` — no type errors introduced.
