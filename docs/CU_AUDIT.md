# ChainLens CU-risk audit

Read-only analysis first, then minimal additive changes (comments, 2 diagnostic log/guard pairs,
1 shared helper). No business logic removed or changed. This builds on — and cross-references —
several real audits performed earlier in this session (the original GoldRush CU-drain audit, the
RPC-instrumentation follow-up, and the wallet-scanner safety audit); it does not repeat their full
findings, only what's newly relevant here.

## 1. External providers in use (real, confirmed)

| Provider | Real key env var(s) | Used by |
|---|---|---|
| GoldRush (Covalent) | `GOLDRUSH_API_KEY`, falls back to `COVALENT_API_KEY` | `src/modules/providerFetchWindow`, `src/modules/holdings`, `src/modules/recoveryPolicy`, `src/modules/pricingAtTimeEngine`, `src/pipeline/index.ts`, `lib/providers/goldrush.ts`, several `app/api/*` routes (see prior GoldRush audit) |
| Alchemy | `ALCHEMY_BASE_KEY`/`ALCHEMY_ETHEREUM_KEY`/`ALCHEMY_ARBITRUM_KEY` (+ fallback aliases, incl. the disclosed `NEXT_PUBLIC_ALCHEMY_BASE_KEY` risk from the earlier safety audit) | same modules as GoldRush (fallback provider), plus `lib/server/lpProof.ts` (LP burn/lock proof, separate subsystem) |
| CoinGecko | `COINGECKO_API_KEY` | `lib/providers/coingecko.ts`, `src/modules/pricingAtTimeEngine` |
| DexScreener | none (public API) | `src/modules/pricing/utils.ts`, `src/modules/pricingAtTimeEngine/sources/multiProviderPriceSource.ts` |
| viem (on-chain RPC, not a metered API) | Alchemy RPC URL, same keys as above | `src/modules/pricingAtTimeEngine/sources/basedex.ts`, `lib/engines/metadataEngine.ts` |
| Moralis | (separate, `lib/server/moralis.ts`) | dev-wallet / base-radar features, not the main scan pipeline |

All of the above are backend-only. Confirmed no provider API key or raw provider URL is ever
constructed or called from frontend code (`app/frontend/**`, `app/terminal/**`) — every real call
site lives under `src/modules/*`, `lib/providers/*`, `lib/engine/modules/*`, or `app/api/*/route.ts`.

## 2. Scan-related routes — engine + provider map

| Route | Engine | Providers touched | Delivery model |
|---|---|---|---|
| `/api/scan` | V2 (`runWalletScanV2` via `router.handleScanRequest`) | GoldRush, Alchemy, CoinGecko/DexScreener (pricing) | Direct serverless (synchronous) |
| `/api/scan-v2` (plural modules split) | V2, same orchestrator, de-duped per (wallet,chains,scanMode) via `scanCache.ts` | same as above | Direct serverless, one request per module |
| `/api/scan-v2/modules/*` (10 routes) | V2, same orchestrator | same as above | Direct serverless — 9-10 concurrent requests per full scan from the frontend (see earlier FUNCTION_INVOCATION_TIMEOUT audit) |
| `/api/scan-v2/full-scan` | V2 orchestrator **+** the new engine chain (holdings/pricing/portfolio/pnl/activity/risk/personality/behavior/signals) | GoldRush, Alchemy, CoinGecko/DexScreener — **and** re-fetches raw events again per chain via the new engine chain (see Finding #1 below) | Direct serverless, single request |
| `/api/scan-v2/full-scan-edge` | Same orchestrator as `/api/scan-v2/full-scan`'s base call (not the new engine chain) | same as `/api/scan` | Vercel Edge runtime, single request |
| `/api/scan-v2/full-scan-job/start` + `.../status` | Same orchestrator as `/api/scan` (no new engine chain) | same as `/api/scan` | Background job + poll (Redis-backed) |
| `/api/scan-token`, `/api/scan-holder` | Separate token/holder-scan features, not the wallet-scan orchestrator | GoldRush/Alchemy (their own call sites) | Direct serverless |
| `/api/wallet-scanner` | Delegates to `/api/dev-wallet` — a separate dev-wallet-detection feature | GoldRush/Alchemy | Direct serverless |

**No route calls the legacy V1 engine** (`lib/server/walletSnapshot.ts`) — confirmed by a repo-wide
import search: nothing under `app/` imports that file. It remains present but fully disconnected,
as established earlier this session.

**Currently, the frontend (`scanWalletV2()`, `app/frontend/api/scanWallet.ts`) calls
`/api/scan-v2/full-scan` directly first**, falling back to `full-scan-job/start` on failure (a very
recent, explicitly-confirmed change — see that file's own "ROUTE-SWAP" disclosure for the
regression risk this reintroduced: `/api/scan-v2/full-scan` is a synchronous route subject to
Vercel's execution-time ceiling, and is now also the single most expensive route in this table,
per Finding #1 below).

## 3. HIGH-RISK findings (flagged in code with `// CU-RISK: HIGH` comments + `logCuRisk` calls)

### Finding #1 — duplicate provider fetches within one `/api/scan-v2/full-scan` request (NEW, found during this audit)

`app/api/scan-v2/full-scan/route.ts` calls both:
- `lib/engine/modules/pnl/computePnl.ts`'s `fetchParsedTrades(walletAddress)`, and
- `lib/engine/modules/activity/computeChainActivity.ts`'s `computeChainActivity(...)` (internally:
  `fetchChainSignals`)

for the **same wallet and same chains, in the same request**. Both independently call
`fetchRawEventsForChain`/`buildTradesWithIntentForChain` per chain (`app/api/_shared/
walletChainPipeline.ts`) — meaning GoldRush/Alchemy raw-event and trade-classification calls happen
**roughly twice per chain** for every `/api/scan-v2/full-scan` request, purely from how the last several
engine-module tasks were each wired in independently without a shared cache between them.

**Not fixed in this pass** (a real fix means either caching the fetch/classification result once at
the route layer and passing it into both modules, or giving `computeChainActivity` a way to accept
pre-fetched trade data — a real refactor, out of this audit's "comments/logs/small guards only"
scope) — flagged with matching `CU-RISK: HIGH` comments and `logCuRisk(...)` calls at both call
sites so it's visible in real request logs (`grep "\[CU-AUDIT\]"`), and a `missing walletAddress`
guard was added at both (previously absent — a real, if minor, gap: neither function checked for an
empty wallet address before making a real provider call).

### Finding #2 (pre-existing, already disclosed/mitigated earlier this session)

`/api/scan-v2/modules/*`'s 9-10-separate-serverless-function pattern (see the earlier
FUNCTION_INVOCATION_TIMEOUT audit and the `/api/scan-v2/full-scan` route's own header) — already
mitigated by the unified route and the job/poll system; not re-flagged with new code changes here,
just cross-referenced.

## 4. MEDIUM-RISK findings

- `src/modules/recoveryPolicy/index.ts`'s per-token deep-history pagination loop — real,
  variable-count, multi-page GoldRush/Alchemy fetch, but bounded by
  `maxHistoricalPagesPerWallet`/`maxHistoricalPagesPerToken` and only reachable via `scanMode:
  'deep'` (never a normal scan). Flagged with a `CU-RISK: MEDIUM` comment (not `HIGH` — it's
  capped, not unbounded).
- `lib/engine/modules/holdings/fetchHoldings.ts` / `lib/engine/modules/pricing/fetchPricing.ts` —
  one real fetch per chain (2 chains), no loop, no duplication with any other module. LOW-to-MEDIUM;
  not flagged, no change needed.

## 5. LOW-RISK (no action)

- `src/modules/providerFetchWindow` itself — one bounded page per provider per chain, never
  deep-pages (Architecture Step 1/8, unchanged all session).
- `src/modules/pricing` (`resolvePrices`) — capped by `MAX_FALLBACK_PRICE_LOOKUPS` (10) per call.
- `lib/engines/metadataEngine.ts` — 2-layer timeout + 24h KV cache already built in (see that
  module's own task).

## 6. Which modules are most CU-heavy (ranked, real basis)

1. **`/api/scan-v2/full-scan`** — now the most expensive route: the full V2 orchestrator (which
   itself fetches raw events + holdings + pricing per chain) **plus** the new engine chain, which
   (per Finding #1) re-fetches raw events/trades a second time per chain. This is also the route
   `scanWalletV2()` now calls directly first.
2. **`/api/scan` / `/api/scan-v2/full-scan-job/start`** — the base V2 orchestrator only, no
   duplication; deep mode adds `recoveryPolicy`'s bounded multi-page fetch.
3. **`/api/scan-v2/modules/*`** — same total orchestrator cost as #2 when all 9-10 are requested
   together (de-duped via `scanCache.ts`), but spread across separate serverless invocations
   (Finding #2, cross-referenced).

## 7. V1 vs V2

- **V1** (`lib/server/walletSnapshot.ts`): confirmed still fully disconnected — no route imports it.
- **V2 base orchestrator** (`runWalletScanV2`/`router.handleScanRequest`): used by every scan route
  in the table above.
- **V2 new engine chain** (`lib/engine/modules/*`: holdings/pricing/portfolio/pnl/activity/risk/
  personality/behavior/signals): only wired into `/api/scan-v2/full-scan` — the source of Finding #1.

## 8. Suggested next steps (not implemented — out of this audit's scope)

1. Fix Finding #1: share one `fetchRawEventsForChain`/`buildTradesWithIntentForChain` result per
   chain across `fetchParsedTrades` and `computeChainActivity` within a single `/api/scan-v2/
   full-scan` request (e.g. a short-lived in-request memoization keyed by `(chain, walletAddress)`,
   or restructure the route to fetch once and pass the result into both modules).
2. Consider whether `/api/scan-v2/full-scan` should reuse `scanCache.ts`'s existing de-dupe
   mechanism (already used by `/api/scan`/`/api/scan-v2/modules/*`) for its own new engine-chain
   fetches, not just the base orchestrator call.
3. Now that `scanWalletV2()` calls `/api/scan-v2/full-scan` directly (a recent, explicitly-confirmed
   change with a disclosed timeout-regression risk), Finding #1's 2x-per-chain cost lands directly
   on every real user scan, not just an edge case — this raises the priority of fixing Finding #1
   above where it would otherwise sit.
