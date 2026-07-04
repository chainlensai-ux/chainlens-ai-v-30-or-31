# Wallet V2 — how each engine actually gets called

There are **two separate, non-overlapping call paths** in this codebase that both compute
wallet-intelligence results. They share several of the same low-level modules, but neither imports
the other, and they were built at different times for different purposes. This doc traces the real
call chain for each — no fabricated names, only what's actually in the repo.

---

## Path A — the original Deep Scan pipeline (`/api/scan-v2`, powers the Wallet Scanner UI)

```
UI: app/terminal/wallet-scanner/page.tsx
  -> POST /api/scan-v2                          (app/api/scan-v2/route.ts)
  -> router.handleModulesRequest / handleModuleRequest   (src/deployment/{router,api}.ts)
  -> runWalletScanV2                             (src/deployment/... wrapper)
  -> runWalletScan                               (src/pipeline/index.ts — THE real orchestrator)
```

`runWalletScan` is one function that sequences 9 modules, stage by stage, per requested chain. Each
stage after stage 1 is wrapped in a `safeRun*` try/catch (Architecture Step 7) so one stage failing
degrades only that stage, never the whole scan.

| Stage | Real function called | Module |
|---|---|---|
| 1 | `fetchProviderWindow(chain, walletAddress, windowDays)` | `src/modules/providerFetchWindow` — **the only network call up to this point** |
| 2 | `normalizeEvents(rawEvents, walletAddress)` | `src/modules/normalization` |
| 3 | `buildChainSelectionObject(normalizedEvents, chainInputs)` | `src/modules/chainSelection` |
| 4 | `buildTimelines(normalizedEvents, chainSelection)` → buy/distribution timelines | `src/modules/timelineBuilder` |
| 4b | `buildBridgeDetectionObject(normalizedEvents)` | `src/modules/bridgeDetection` (pure, no cost) |
| 4c | `buildSellTimeline({...})` → the real V2 sell read-model | `src/modules/sellTimeline` |
| 5 | `buildRecoveryPolicyObject({...})` — **only when `scanMode === 'deep'`**, the one other real network call in this whole file | `src/modules/recoveryPolicy` |
| 6 | `buildFifoOutput({...})` — real FIFO matching, now wired to real price lookups via `priceLotsForWallet` | `src/modules/fifoEngine` |
| 6b | `resolvePricingAtTime(...)` using `PRICE_SOURCES` (GoldRush primary, DexScreener/CoinGecko/on-chain-Uniswap-V3 fallback via `multiProviderPriceSource`) | `src/modules/pricingAtTimeEngine` |
| 7 | `buildPnlSummary({...})`, fed by `buildFifoBackedPnlResolvers(matchedLots)` (real cost/proceeds pulled straight from FIFO's own matched lots) | `src/modules/pnlEngine` |
| 8 | `buildBehaviorIntelObject({...})`, reading `sellTimelineV2.entries` (not the legacy stage-4 sellTimeline) | `src/modules/behaviorIntel` |
| 9 | `assembleReport({...})` — merges every stage's output into the final `FinalReport` returned to the UI | `src/modules/finalReportAssembler` |

Nothing built in this session (`lib/engines/*`, the new `/api/{pnl,transactions,wallet-profile,
debug-engines,token-scan}` routes) is imported by this file. This pipeline is untouched.

---

## Path B — the new standalone engine chain (this session's work, `/api/{pnl,transactions,wallet-profile,debug-engines,token-scan}`)

None of these routes call `runWalletScan`. They each independently re-derive whatever raw data they
need via one shared helper, then call the real per-engine functions directly. The shared helper:

**`app/api/_shared/walletChainPipeline.ts`** — built this session to bridge the gap between "these
routes only get `{walletAddress, chains}`" and "none of swapNormalizer/tradeIntent/lotOpener/
lotCloser fetch anything themselves." Its real chain, per chain:

```
fetchRawEventsForChain(chain, walletAddress)
  -> fetchProviderWindow(chain, walletAddress, getProviderFetchWindowDays())   [src/modules/providerFetchWindow]
       (getProviderFetchWindowDays() -> getEffectiveFetchWindow() — 90 by default,
        opt-in wider via PROVIDER_FETCH_WINDOW_OVERRIDE env var)

buildTradesWithIntentForChain(chain, walletAddress)
  -> fetchRawEventsForChain(...)
  -> groupRawEventsIntoTxBundles(rawEvents, chain)        [pure regrouping, this file]
  -> normalizeTrades(bundles, walletAddress)               [src/modules/swapNormalizer]
  -> classifyTradeIntent(normalizedTrades)                 [src/modules/tradeIntent]

buildLotsForChain(chain, walletAddress)
  -> buildTradesWithIntentForChain(...)
  -> openLots(trades)                                      [src/modules/lotOpener]
  -> closeLots(openedLots, trades)                         [src/modules/lotCloser]

buildUnrealizedPnlForChain(chain, walletAddress)
  -> fetchHoldings(chain, walletAddress)  +  buildLotsForChain(...)   [in parallel]
  -> (cross-references each holding to its real open FIFO lot for acquiredAtTimestamp)
  -> computeUnrealizedPnl({chain, walletAddress, holdings})  [lib/engines/unrealizedPnlEngine.ts]
       -> getPriceAtTime({chain, tokenAddress, timestamp})   [lib/engines/pricingAtTimeEngine.ts]
            -> fetchGoldrushHistoricalPrice / fetchCoingeckoHistoricalPrice / fetchOnchainDexPriceAtTime
               [lib/providers/{goldrush,coingecko,onchainDex}.ts — all 3 run in parallel]

buildTradeTimelineForChain(chain, walletAddress)
  -> buildTradesWithIntentForChain(...)
  -> tradeWithIntentToTimelineInputs(trade)  for each trade   [adapter, this file]
  -> buildTradeTimelineV2({chain, walletAddress, transfers, swaps})   [lib/engines/tradeTimelineEngineV2.ts]
```

Each route composes these differently:

- **`/api/pnl`** — `buildLotsForChain` → `computeRealizedPnl(lots.closedLots)` [`src/modules/realizedPnl`], plus `buildUnrealizedPnlForChain`. Returns `{realized, unrealized}`.
- **`/api/transactions`** — `buildTradeTimelineForChain` per chain. Returns `{transactions}`.
- **`/api/wallet-profile`** and **`/api/debug-engines`** — the fullest chain: wallet-wide `fetchRawEventsForChain` (all chains) → `normalizeEvents` → `buildChainSelectionObject` → `buildTimelines` + `buildBridgeDetectionObject` + `buildSellTimeline` → `buildBehaviorIntelObject`; wallet-wide `fetchHoldings` (all chains) → `buildPortfolioSummary` [`src/modules/portfolio`]; then per chain: `buildLotsForChain` → `computeRealizedPnl`, `buildUnrealizedPnlForChain`, `buildTradeTimelineV2`, all fed into `computeSmartMoneyScore(req)` [`lib/engines/smartMoneyScoreEngine.ts`] (single-chain-scoped, so it's called once per requested chain).
- **`/api/token-scan`** — the simplest: directly calls `getPriceAtTime({chain, tokenAddress, timestamp})`. No shared-pipeline involvement at all.

### Key structural facts worth remembering
- Path A and Path B use **different sell-timeline / PnL / pricing implementations** that happen to have similar names (`realizedPnl` here vs. `pnlEngine` there; `pricingAtTimeEngine` exists as both a `src/modules` batch-pricer for Path A and a `lib/engines` single-lookup version for Path B) — this was disclosed and kept deliberately separate throughout the session rather than merged, per each task's own "do not modify existing engines" constraint.
- Both paths ultimately bottom out at the exact same single real fetch function: `fetchProviderWindow` (`src/modules/providerFetchWindow`). That's the only place either path makes a raw-data network call (aside from `recoveryPolicy`, which only Path A's deep-scan mode uses, and the pricing provider calls, which both paths make independently).
- `recoveryPolicy` (deep historical recovery) is wired into Path A only. Path B's routes explicitly pass an empty `RecoveryPolicyResult` and disclose this as an intentional, uncomputed gap.
