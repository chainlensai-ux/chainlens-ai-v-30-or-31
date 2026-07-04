# Wallet Scanner backend — static architecture & safety audit

Static audit only (no live provider calls — this sandbox has no GoldRush/Alchemy keys configured).
All findings below are grounded in the actual source, verified by direct reads/greps, not assumed.

## 1. Architecture diagram

```
                         ┌─────────────────────────────────────────────┐
                         │           SHARED FOUNDATION (both paths)      │
                         │  src/modules/providerFetchWindow              │
                         │    fetchProviderWindow(chain, wallet, days)   │
                         │    -> fetchGoldrushRawEvents  (GOLDRUSH_API_KEY)│
                         │    -> fetchAlchemyRawEvents   (ALCHEMY_*_KEY) │
                         │  ONE bounded page per provider. Never deep-  │
                         │  pages. Fixed window [80,365], default 90.   │
                         └───────────────┬───────────────┬─────────────┘
                                         │               │
                    Path A               │               │             Path B
     ┌───────────────────────────────────┘               └──────────────────────────────────┐
     │                                                                                       │
UI: wallet-scanner page                                                    /api/{pnl,transactions,
  -> POST /api/scan-v2                                                      wallet-profile,debug-engines}
  -> src/deployment/{router,api}.ts                                          -> app/api/_shared/
  -> runWalletScanV2 -> runWalletScan (src/pipeline/index.ts)                    walletChainPipeline.ts
       1. fetchProviderWindow                                                -> normalizeTrades (swapNormalizer)
       2. normalizeEvents                                                    -> classifyTradeIntent (tradeIntent)
       3. buildChainSelectionObject                                          -> openLots / closeLots
       4. buildTimelines + buildBridgeDetectionObject + buildSellTimeline    -> computeRealizedPnl (realizedPnl)
       5. buildRecoveryPolicyObject   (deep scanMode only, 2nd network call) -> computeUnrealizedPnl (lib/engines)
       6. buildFifoOutput                                                        -> getPriceAtTime (lib/engines/
       6b. resolvePricingAtTime (src/modules/pricingAtTimeEngine)                      pricingAtTimeEngine)
       7. buildPnlSummary (src/modules/pnlEngine)                            -> buildTradeTimelineV2 (lib/engines)
       8. buildBehaviorIntelObject                                          -> buildBehaviorIntelObject (shared
       9. assembleReport -> FinalReport                                          w/ Path A, called independently)
                                                                             -> buildPortfolioSummary (portfolio)
                                                                             -> computeSmartMoneyScore (lib/engines)

/api/token-scan -> getPriceAtTime directly (no walletChainPipeline involvement at all)
```

## 2. Confirmed invariants

All verified directly against source in this session — not assumed:

1. **Path A and Path B share exactly `fetchProviderWindow` and the pricing layer, nothing else.**
   Grepped every Path B route file for `runWalletScan` — the only 2 hits are inside disclosure
   *comments* referencing it as a read-only reference sequence, never an actual import or call.
   `src/pipeline/index.ts` is not imported by any of `app/api/{pnl,transactions,wallet-profile,
   debug-engines,token-scan}/route.ts` or `app/api/_shared/walletChainPipeline.ts`.
   Both paths do independently call `buildBehaviorIntelObject`/`buildChainSelectionObject`/
   `buildPortfolioSummary` — these are pure, stateless functions with no shared mutable state, so
   calling them from two places is not a sharing risk, just code reuse.

2. **No route in Path B calls `runWalletScanV2`.** Confirmed by the same grep above.

3. **No module mutates shared state that crosses requests/routes**, with one caveat (see Risk #1
   below): `src/modules/pricingAtTimeEngine/sources/basedex.ts` caches a single viem `PublicClient`
   in a module-level `let cachedBaseClient` — this is a stateless RPC client handle (safe to share,
   same pattern as any DB connection pool), not request-scoped data, so it cannot leak one request's
   results into another's.

4. **The raw-fetch stage never deep-pages.** `MAX_RAW_EVENTS_PER_PROVIDER` (types.ts) is a single
   bounded page per provider per chain; `fetchProviderWindow` makes exactly one call each to
   GoldRush and Alchemy per invocation, no loop.

5. **`recoveryPolicy` (the one other stage permitted to fetch beyond the base window) is
   page-capped**: `maxHistoricalPagesPerWallet: 6`, `maxHistoricalPagesPerToken: 4`
   (`src/modules/recoveryPolicy/types.ts`) — enforced in `src/modules/recoveryPolicy/index.ts` via
   an explicit budget check before each additional page, not an unbounded while-loop.

6. **Every direct `fetch()` call inside `src/modules/{recoveryPolicy,holdings,providerFetchWindow}/
   utils.ts` and `src/modules/{pricingAtTimeEngine/sources/dexscreener,pricing/utils,
   pricingAtTimeEngine/sources/coingecko}.ts` is paired 1:1 with an `AbortController`/`signal:`
   timeout guard** — counted per file; no file has more `fetch(` calls than timeout guards.

7. **Missing pricing/metadata degrades gracefully, never crashes.** Every provider adapter this
   session touched or built (`lib/providers/{goldrush,coingecko,onchainDex}.ts`,
   `getPriceAtTime`) resolves to `{priceUsd: null, confidence: 'none', evidence: []}` on any failure
   rather than throwing; `computeUnrealizedPnl`/`computeRealizedPnl` never fabricate a value for an
   unpriced token — they surface it honestly (`unresolvedHoldings`, `confidence: 'none'`).

8. **No `NEXT_PUBLIC_*` env var is read as an actual secret/config value in backend pricing or
   engine logic** — the only real `NEXT_PUBLIC_*` reads in `src/modules`/`lib/engines`/`lib/
   providers` are `NEXT_PUBLIC_ENABLE_DEV_TOOLS` (a boolean feature flag gating browser-console
   devtools exposure, not a secret) — see Risk #2 below for one partial exception.

## 3. Env var findings — literal names, corrected

The task assumed these exact names: `ALCHEMY_ETH_KEY`, `ALCHEMY_ARB_KEY`, `ETH_RPC_URL`,
`BASE_RPC_URL`, `ARBITRUM_RPC_URL`. **None of these 5 exact names are read anywhere in the
codebase.** The real names (`src/modules/providerFetchWindow/utils.ts`, mirrored in `holdings/
utils.ts` and `recoveryPolicy/utils.ts`):

| Purpose | Real env var name(s) actually read |
|---|---|
| GoldRush/Covalent key | `GOLDRUSH_API_KEY`, falls back to `COVALENT_API_KEY` |
| Alchemy Base key | `ALCHEMY_BASE_KEY`, `ALCHEMY_BASE_API_KEY`, `BASE_ALCHEMY_API_KEY`, `ALCHEMY_API_KEY`, `NEXT_PUBLIC_ALCHEMY_BASE_KEY` |
| Alchemy Ethereum key | `ALCHEMY_ETHEREUM_KEY`, `ALCHEMY_ETH_KEY`, `ALCHEMY_ETH_API_KEY`, `ALCHEMY_API_KEY` |
| Alchemy Arbitrum key | `ALCHEMY_ARBITRUM_KEY`, `ALCHEMY_ARBITRUM_API_KEY`, `ARBITRUM_ALCHEMY_API_KEY`, `ALCHEMY_API_KEY` |
| Base RPC (LP proof only, separate subsystem) | `ALCHEMY_BASE_RPC_URL` |
| Coingecko | `COINGECKO_API_KEY` |

There is no standalone `ETH_RPC_URL`/`BASE_RPC_URL`/`ARBITRUM_RPC_URL` triple anywhere — RPC access
for pricing/holdings/fetch goes exclusively through Alchemy's own URL construction
(`https://{network-slug}.g.alchemy.com/v2/{key}`), not a raw configurable RPC URL, except the one
already-known exception (`ALCHEMY_BASE_RPC_URL`, used only by the separate LP-proof subsystem).

## 4. Risks / future failure modes

1. **`NEXT_PUBLIC_ALCHEMY_BASE_KEY` is accepted as a real fallback source for the Alchemy Base API
   key** in 3 real files (`providerFetchWindow/utils.ts`, `holdings/utils.ts`,
   `recoveryPolicy/utils.ts`). If a deployment ever actually sets that var (rather than one of the
   4 non-public alternatives), Next.js will inline that value into the client-side JS bundle at
   build time (confirmed behavior, established earlier this session) — a real API key would leak to
   every browser. No code currently sets it, but the fallback path exists and is easy to trip by a
   future deployer copying a `NEXT_PUBLIC_` var out of habit.

2. **`rpcDebugLog` (`lib/server/rpcDebug.ts`) is an unbounded, never-truncated, never-cleared
   module-level array** (`rpcDebugLog.push(...)`, no cap). On Vercel's serverless model each
   invocation gets a fresh instance so this is low-risk in production, but under `next dev` or any
   long-lived Node process (local dev, a future non-serverless deployment target) this grows
   without bound for the life of the process — a slow memory leak, not visible in short-lived
   testing.

3. **No rate limiting or auth on any of the 5 new Path B routes** (`/api/{pnl,transactions,
   wallet-profile,token-scan}` have none at all; `/api/debug-engines` has the admin-override 404
   gate added this session, but that only restricts *production*, not request volume). Every one of
   these routes triggers real GoldRush/Alchemy/CoinGecko calls per request — this is the same class
   of CU-drain risk flagged in this session's earlier GoldRush audit for other routes, and these 5
   were never covered by that audit since they didn't exist yet.

4. **GoldRush SDK client (`GoldRushClient`, used by `lib/providers/goldrush.ts` and
   `src/pipeline/index.ts`) has no explicit request timeout configured** — it relies on the SDK's
   own (likely axios) default, not an app-level `AbortController` like every raw `fetch()` call in
   this codebase already has. A slow/hanging GoldRush response has no code-level ceiling here, only
   whatever the hosting platform's own function-timeout enforces.

5. **viem's `PublicClient` (on-chain DEX pricing, `basedex.ts`) is constructed with
   `transport: http(rpcUrl)` and no explicit `timeout` option** — relies on viem's own library
   default rather than an app-configured value, inconsistent with this codebase's otherwise
   consistent "every network call gets an explicit timeout" pattern.

6. **Path A and Path B maintain two independent PnL/pricing/sell-timeline implementations**
   (`src/modules/pnlEngine` vs. `src/modules/realizedPnl`; `src/modules/pricingAtTimeEngine` (batch)
   vs. `lib/engines/pricingAtTimeEngine.ts` (single-lookup); `src/modules/sellTimeline` used by both,
   but `lotOpener`/`lotCloser` only by Path B) — not a bug today (each was deliberately kept separate
   per each task's "don't modify existing engines" constraint), but a genuine long-term
   maintenance/drift risk: a real bug fix applied to one PnL implementation will not automatically
   apply to the other, and the two can silently diverge in behavior for the same wallet.

## 5. Recommendations

1. Remove `NEXT_PUBLIC_ALCHEMY_BASE_KEY` from the 3 fallback key-name arrays, or rename it to a
   non-`NEXT_PUBLIC_` name — closes risk #1 without needing any deployment to change anything (the
   4 other fallback names already cover the real use case).
2. Cap `rpcDebugLog` at a fixed max length (ring buffer — drop oldest on overflow) so it can never
   grow unbounded in a long-lived process, independent of whether it's ever cleared.
3. Add basic per-IP rate limiting to the 5 new Path B routes, matching whatever convention this
   codebase already uses elsewhere (an existing per-IP/global limiter pattern was applied to the
   diagnostics routes earlier this session — reuse it rather than inventing a new one).
4. Wrap the `GoldRushClient` SDK calls and viem's `PublicClient` RPC calls with the same explicit
   `AbortController`/timeout pattern already used by every raw `fetch()` call in this codebase, so
   a hung provider/RPC response has an app-level ceiling instead of relying on the hosting
   platform's own function timeout as the only backstop.
5. Add a short top-of-file note in each of the duplicated-purpose module pairs (risk #6) pointing to
   its counterpart, so a future bug fix to one is at least flagged for review against the other,
   rather than relying on someone rediscovering the split from scratch.
