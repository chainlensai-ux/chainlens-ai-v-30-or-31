# Wallet Scanner API Cost Map (Audit)

Audit-only document. No logic was changed to produce this map. Scope: `app/api/wallet/route.ts`, `lib/server/walletSnapshot.ts`, `lib/server/moralis.ts`, and the section labels in `app/terminal/wallet-scanner/page.tsx`.

All line numbers below refer to the code as of this audit and will drift as the files change.

## How a scan is shaped (read this first)

`app/api/wallet/route.ts` resolves a scan into one of 3 modes before calling `fetchWalletSnapshot()`:
- **basic** — `cacheMode: 'holdings'`, no `deepScan`/`deepActivity`/`includeActivity` flag.
- **deep** — `deepScan` or `deepActivity` or `includeActivity` true. Adds the activity/FIFO/trade-intelligence pipeline.
- **historical** — `historicalCoverage`/`historicalScan` explicitly requested on top of deep. Adds multi-page historical transfer recovery.

Each mode has its own cache key and TTL (`app/api/wallet/route.ts:91-94`): basic 5 min, deep 60 min, historical 24h, plus a 30 min deep cooldown and a 10 min historical cooldown per wallet (`:111-116`). `debugFresh`/`bypassCache`/`refresh` query params bypass all of this (`:766-797`).

## Section-by-section map

### 1. Portfolio Value
- **Backend fields**: `totalValue`, `totalUsdAvailable`, `providerUsed`, `providerStatus`
- **Providers**: Zerion (`wallets/{addr}/portfolio/`) primary for the USD total; Moralis (`erc20` balances, per active chain) primary for holdings detail; GoldRush/Alchemy hold no role here directly.
- **Functions**: `zerionGet('wallets/{addr}/portfolio/')` (`walletSnapshot.ts:12023`), `fetchMoralisBalances()` per chain (`:12224`)
- **When it runs**: Zerion portfolio + positions fire on **every scan** (`walletSnapshot.ts:12012-12042`), unconditionally, whenever `ZERION_KEY` is configured — not gated by basic/deep/debug. Moralis holdings also fire on **every scan** per active chain, unconditionally whenever `MORALIS_API_KEY` is configured and `MORALIS_HOLDINGS_DISABLED` isn't set (`:12218`).
- **Cost**: Zerion — 2 calls/scan (portfolio + positions), no cache layer in front of either (`:12046-12048` notes this explicitly: "no cache layer sits in front of them"). Moralis holdings — 1 call per active chain (`activeChains.map`, parallel), cached 10 min with in-flight dedupe (`moralis.ts:25-27`).
- **Cache**: Moralis holdings: in-memory `_cache` Map, 10 min TTL, in-flight dedupe (`moralis.ts:25-72`). Zerion: none — every uncached route-level scan re-fires both Zerion endpoints.
- **Necessity**: Critical (Zerion total) / Useful (Moralis per-chain detail, but see waste note below).
- **Replacement candidates**: Moralis holdings are fetched unconditionally even when Zerion's portfolio total is already usable and GoldRush balances could fill the gap for non-EVM-exotic chains — there's no "skip Moralis holdings when Zerion already verified the total" gate. Zerion itself has zero caching at all, despite running on literally every request including basic scans.
- **Risk if removed**: missing holdings detail (symbol/balance granularity) if Moralis dropped; Zerion is the only verified total-value source, so removing it risks `accuracy loss` on `totalValue`.

### 2. Holdings
- Same data path as Portfolio Value — `holdings[]` is built from the Moralis-primary / Zerion-positions-fallback / GoldRush-final-fallback merge (`walletSnapshot.ts:12103-12278`).
- **Provider priority documented in code**: Moralis (primary, after chain discovery) → Zerion positions (provisional fallback, used before Moralis returns) → GoldRush (final fallback) (`:12103-12106`).
- **Cost/cache**: as above. Coverage-aware merge avoids double-counting positions Moralis already covers (`:12248-12264`) — this part is already efficient.
- **Necessity**: Critical.
- **Replacement candidates**: none needed structurally; the waste is in Section 1 (no caching on Zerion, no skip-if-Zerion-already-confirmed gate on Moralis).

### 3. Chain Exposure
- **Backend fields**: `walletFacts.summary.chainExposure`, derived from `discoveredChains` (chain discovery phase, not separately billed beyond the holdings calls already counted above).
- **Providers**: same holdings calls (Moralis/Zerion/GoldRush) — no separate provider call.
- **When it runs**: every scan (derived from holdings already fetched).
- **Necessity**: Critical (cheap — free byproduct of Section 1/2).

### 4. Activity / Evidence Indexed
- **Backend fields**: `walletEvidenceSummary` (`totalEvents`, `eventsWithHash`, `eventsWithTimestamp`), `walletModuleCoverage.activity`
- **Providers**: GoldRush primary (`transactions_v3` via `fetchGoldrushPnlEvents`), Moralis fallback (`erc20/transfers`) **only if GoldRush returns zero events**, Alchemy deferred supplement.
- **Functions**: `fetchGoldrushPnlEvents(addr, 'base-mainnet', ...)` (`:12041`), `fetchMoralisTransfers()` fallback (`:12592`)
- **When it runs**: only `deep`/`historical` scans (`activityRequested` gate). Basic scans never touch activity.
- **Cost**: GoldRush — 1 credit (base) + 1 credit (eth, only if `requestedChain === 'eth'` or `chainMode === 'eth'`, see `_shouldFetchGrEthEager`, `:12001`). Moralis fallback — 1 call, only fired when GoldRush returned `events.length === 0` (`:12590`).
- **Cache**: GoldRush activity has no dedicated TTL cache visible in this path beyond the outer route-level snapshot cache; Moralis transfers fallback uses `fetchMoralisTransfers`'s 5 min TTL + in-flight dedupe (`moralis.ts:192-194`).
- **Necessity**: Critical for deep scans, Optional for basic (correctly skipped).
- **Risk if removed**: missing activity, worse PnL.

### 5. Wallet Status
- Pure derived field (`walletLoadState`, `walletModuleCoverage`) — **no external provider call**, computed from whatever has already been fetched (`app/api/wallet/route.ts:209-277`, `:432-725`).
- **Necessity**: Critical, zero marginal cost.

### 6. Provider PnL Summary
- **Backend fields**: `_providerProfitResult` → surfaced PnL summary card ("Provider PnL Summary" / `provider_summary` copy in `page.tsx:2929`)
- **Provider**: Moralis only — `fetchMoralisProfitabilitySummary(addr, chain, 'all')`
- **Function**: `walletSnapshot.ts:16297`
- **When it runs**: only when ChainLens's own FIFO reconstruction found **zero** closed lots (`_providerProfitFifoFoundNoLots`) AND (`totalValue >= 1000` OR `debug` OR `deepScan`) AND scan is still under its credit hard cap (`:16282-16284`).
- **Cost**: up to 2 chain attempts normally, up to 3 in debug (`_providerProfitMaxAttempts`, `:16293`), tried in sequence (`for` loop, not parallel) across `requestedChain`, `activeChains`, `eth`, `base` (deduped). So worst case **2-3 Moralis profitability calls in a single scan**, sequential.
- **Cache**: 30 min TTL + in-flight dedupe per `chain:address:timeframe` key (`moralis.ts:356-358`).
- **Necessity**: Useful — it's a real fallback for wallets ChainLens's own FIFO can't reconstruct, but it's the single biggest contributor to "5 Moralis calls in one scan" because it's sequential and multi-chain.
- **Replacement candidates**: Could cap at 1 candidate chain (the one with the highest discovered value) instead of trying up to 3; could run the chain attempts with `Promise.all` instead of sequential `for`/`await` to cut wall-clock (not credit count) since each chain attempt is an independent paid call regardless of order.
- **Risk if removed**: wallets where FIFO finds 0 closed lots would show no PnL summary at all (`missing PnL`).

### 7. Portfolio Movement / 24h Holdings Move
- Derived from current `holdings[].price`/`value` vs. a stored prior snapshot if present — no dedicated new provider call; reuses Section 1/2 data.
- **Necessity**: Useful, effectively free.

### 8. Portfolio History PnL (14d/30d mark-to-market, `page.tsx:3042`)
- Derived client-side from `walletTradeStatsSummary`/`estimatedPnl` already computed server-side from the FIFO/activity pipeline — no separate provider call identified in the audited files.
- **Necessity**: Useful, effectively free (reuses Section 4/9 data).

### 9. ChainLens FIFO PnL
- **Backend fields**: `walletLotSummary`, `walletTradeStatsSummary`, `fifoPnL` in `walletModuleCoverage`
- **Providers**: none directly — consumes the `events[]` array already built by Section 4 (Activity) plus price evidence (GoldRush historical price / shared RPC receipt cache) for swap legs.
- **Price evidence calls**: `fetchGoldrushHistoricalPrice()` (GoldRush), gated by `MAX_PRICE_ATTEMPTS` budget (`:5099-5206`) and cached via `reqPriceCache`/`isGoldrushPriceCached` per-request map — these are the main *new* calls this section can trigger beyond Activity.
- **When it runs**: deep/historical scans only, after Activity.
- **Necessity**: Critical for deep scans.

### 10. Position Estimate
- **Backend fields**: `estimatedPnl` (average-cost fallback layer), `walletOpenPositionSummary`
- **Providers**: none new — derived from holdings + FIFO output.
- **Necessity**: Useful, free byproduct.

### 11. Trading Intelligence
- **Backend fields**: `tradeIntelligence`, computed via `computeWindowedPnl`/`computeBotScore`/`computeWalletPersonality` (`app/api/wallet/route.ts:3`)
- **Providers**: none — pure derivation over already-fetched FIFO/activity data (`lib/server/walletIntelligence.ts`, not separately audited here since it makes no provider calls per the route import).
- **Necessity**: Useful, free.

### 12. Bot Score / 13. Wallet Personality
- Same as Trading Intelligence — derived, no provider calls.
- **Necessity**: Useful, free.

### 14. Flow Read
- Not a distinct backend section in the audited files — appears to be a UI framing over Activity/Chain Exposure data already covered above. No separate provider call found.

### 15. Historical Recovery
- **Backend fields**: `walletHistoricalCoverageSummary`, `walletHistoricalRecoveryStatus`/`Reason`
- **Providers**: GoldRush (`fetchGoldrushHistoricalPage`, `transactions_v3` paginated) primary, Moralis (`fetchMoralisTransfersPaginated`, page-1-only "Phase 20" or full paginated in the dedicated historical path) and Alchemy (`fetchAlchemyBaseTransfersPaginated`) as supplements.
- **When it runs**: **only** when `historicalCoverage`/`historicalScan` is explicitly requested (`app/api/wallet/route.ts:781`), gated further by a 10 min cooldown (`:812-822`) and a cost guard that skips re-running historical for wallets whose last scan was very expensive (`>100k raw log events` or `>25s duration`, `:824-830`).
- **Cost**: highest of any section — up to `maxHistoricalPages` (default 3, hard cap up to 50 for admin forensic scans, `WALLET_ADMIN_HISTORICAL_HARD_CAP`) per chain, times up to 2 chains (base+eth) inside `buildWalletHistoricalCoverage` (`:16258`). Plus "Phase 18/19/20" supplemental Moralis transfer calls described below.
- **Cache**: 24h TTL (`HISTORICAL_COVERAGE_TTL_MS`, `:2591`), persistent cooldown survives cold starts (`app/api/wallet/route.ts:816-822`).
- **Necessity**: Useful but explicitly opt-in/expensive by design — this is already correctly gated behind explicit user request + cooldown + cost guard.
- **Risk if removed**: `missing PnL` for wallets with deep/old history GoldRush's default window doesn't reach.

### 16. FIFO Proof
- Same data as Section 9 (`walletLotSummary`/debug `sampleOpenLots`/`sampleReconstructedSwaps`) surfaced as a proof/debug view (`page.tsx:3880`, "FIFO Proof Open Check"). No separate provider call.

### 17. CORTEX Wallet Read
- Aggregated summary card (`page.tsx:4780`, `4926`) — pure UI rollup of the above sections, no new provider call.

### 18. Debug / audit fields
- **Backend fields**: `_debug`, `_diagnostics`, `apiAudit`, `walletScanBudget`, `walletDeepScanOptimizationDebug`
- **Providers**: none of these *cause* calls — they only report on calls already made (`_trackCall()` calls throughout `walletSnapshot.ts`, aggregated into `apiAudit` ~`:2351` and `:16264-16339`).
- **Caveat (the real cost risk)**: `debugFresh`/`bypassCache=true` (route.ts `:770`, `:793-797`) bypasses **both** the route's memory cache and the persistent cache, forcing a fully live re-scan including Activity/Historical paths if also requested — this is the main way "debug" inflates spend, not the debug fields themselves.
- **Necessity**: Critical for operating the system safely (cost visibility), zero direct cost.

## Why a single scan can hit ~5 Moralis calls

These are independent, separately-gated Moralis call sites found in `walletSnapshot.ts`. On a deep/historical scan for a multi-chain, thin-GoldRush-coverage wallet, several can fire in the same request:

1. **Holdings** — 1 call per active chain, every scan (`:12224`). Typically 1-2 (base [+eth]).
2. **Phase 1 fallback transfers** — 1 call, only if GoldRush activity returned 0 events (`:12592`).
3. **Phase 18 ETH/BASE supplement** — 1 call, only if Phase 1 fallback was used AND the supplement chain has >$1 value AND GoldRush didn't already cover it (`:12671-12677`).
4. **Phase 19 multi-chain supplement** — up to 2 calls, for non-eth/base chains with ≥$10 value, deep scans only, independent of whether GoldRush found anything (`:12758`, this one is NOT gated on GoldRush failing — it always tries eligible side chains).
5. **Phase 20 Moralis-first paginated transfers** — 1 call group (up to 10 pages), gated on thin GoldRush coverage (`<20 events`) or an unmatched-sell signal (`:12830-12834`).
6. **Provider PnL Summary** — up to 2-3 sequential calls, gated on FIFO finding 0 closed lots (`:16294-16297`).

Holdings (1-2) + Phase 1 fallback (1) + Phase 18 (1) + Provider PnL Summary (1-2, since usually only 1-2 of the candidate chains are real) line up almost exactly to the "5 Moralis calls" symptom on a deep scan of a thin/multi-chain wallet whose GoldRush coverage came back weak. Phase 19/20 add more on top for genuinely multi-chain or recovery-needed wallets.

## What can move to another provider/cache instead

- **Zerion portfolio/positions (Section 1)**: zero caching today, fires on literally every scan including basic. Add a short (1-2 min) memory cache + in-flight dedupe like Moralis already has — same pattern, no new infrastructure needed, biggest single "wasteful" item found.
- **Moralis holdings (Section 1/2)**: fires unconditionally even when Zerion's portfolio total is already verified. Could be skipped/delayed for chains where Zerion already returned a verified, non-zero position for that chain — currently there's no such skip.
- **Provider PnL Summary (Section 6)**: sequential `for` loop across up to 3 chains — switch to `Promise.all` over the (already deduped, already capped) candidate list to cut latency; consider capping non-debug scans to the single highest-value chain instead of 2.
- **Phase 19 multi-chain supplement**: always runs for eligible side chains regardless of whether GoldRush already had good Base/ETH coverage — could be skipped entirely for "non-trader" wallets (the codebase already has a `non_trader_address_type` early-exit concept used elsewhere, `app/api/wallet/route.ts:236`) since side-chain activity rarely matters if the wallet shows no trading behavior.
- **Debug fresh bypass**: already correctly scoped to `pro`/`elite` + a dev bypass; the main lever to reduce its blast radius is reminding callers that `debugFresh`/`bypassCache` should not be used for routine UI refreshes, only diagnostics — this is a usage-discipline issue, not a code defect.

## Duplicate/overlapping calls across providers

- GoldRush and Alchemy both fetch "first transaction on chain" style data in different phases (`getFirstTxOnChain` for Alchemy, GoldRush historical pages elsewhere) — these serve different purposes (wallet age vs. transfer history) so not a true duplicate, but worth flagging since both hit the RPC/provider layer for overlapping wallet-age-adjacent signals.
- Phase 18 and Phase 20 can both attempt a Moralis transfer fetch for the same wallet within one request if both their gates are independently satisfied (Phase 18 triggers off "Phase 1 fallback used", Phase 20 off "GoldRush thin or unmatched sell") — they target different chains/pagination depths by design, but there is no single combined "do we already have enough Moralis transfer data" check across phases 1/18/19/20 before firing the next one; each phase only checks its own immediate predecessor's outcome.

## Final table

| Provider | Current wallet-scanner use | Approx calls per normal (basic) scan | Approx calls per deep scan | Main value | Biggest waste risk | Suggested optimization |
|---|---|---|---|---|---|---|
| Zerion | Portfolio total (primary) + positions (fallback layer) | 2 (always, uncached) | 2 (always, uncached) | Only verified total-value source | Zero caching at all, fires every single scan including basic | Add short TTL memory cache + in-flight dedupe, same pattern as Moralis |
| Moralis | Holdings (primary), activity fallback, multi-chain supplements (Phase 18/19/20), Provider PnL Summary | 1-2 (holdings only) | 3-7 (holdings + up to 4 transfer-supplement phases + up to 2-3 PnL summary calls) | Primary holdings source; only real PnL fallback when FIFO finds nothing | Sequential Provider PnL Summary calls across redundant candidate chains; Phase 19 runs even when GoldRush coverage was fine | Cap PnL Summary to top-1 chain for non-debug; parallelize remaining candidates; skip Phase 19 for non-trader wallets |
| GoldRush/Covalent | Activity (primary), historical recovery (primary), swap/lot price evidence | 0 (basic scans skip activity) | 1-2 (base [+eth]) + price-evidence calls | Primary activity + historical-price source | None major found — already gated behind `activityRequested`/`historicalCoverage` and has 24h historical cache | None needed beyond what's already in place |
| Alchemy | First-tx date, nonce, behavior fallback, Base transfer supplement (Phase 20) | 1-2 (firstTx + nonce, if `ALCHEMY_BASE_KEY` set) | 2-5 (adds behavior + Phase 20 paginated supplement) | RPC-grade first-tx/nonce truth, deferred Base activity backup | Phase 20 fires its own Alchemy paginated calls "alongside" Moralis/GoldRush rather than only as a true last resort | Confirm Phase 20 Alchemy calls are skipped when Moralis/GoldRush in the same phase already returned enough events |
| Internal cache (memory) | Holdings (10m), transfers (5m), profitability (30m) on the Moralis client; route-level basic/deep/historical snapshot cache (5m/60m/24h) | reduces repeat scans within TTL | same | Cuts cost on repeat scans of the same wallet within TTL | `debugFresh`/`bypassCache` bypasses all of it | Keep as-is; just gate `debugFresh` usage to genuine diagnostics |

## Risks if any of the above were removed (summary)

- Removing Zerion: lose the only verified total-value cross-check → `accuracy loss` on `totalValue`, more wallets fall back to "estimated from holdings."
- Removing Moralis holdings: `missing holdings` detail on chains GoldRush/Zerion don't cover as well.
- Removing Moralis activity fallback/supplements: `missing activity`, weaker multi-chain coverage, `worse chain coverage`.
- Removing Provider PnL Summary: `missing PnL` for wallets where ChainLens's own FIFO reconstruction finds zero closed lots.
- Removing/shrinking Historical Recovery: `missing PnL` for old/high-volume wallets, but this section is already correctly opt-in and cost-guarded.
- Tightening any of the above too aggressively risks `worse UX only` in the case of Wallet Status/CORTEX Wallet Read/Debug fields, since those carry no provider cost themselves — cuts there save nothing and only hurt visibility.
