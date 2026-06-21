# Wallet Scanner — Provider Cost & Credit Audit (read-only)

**Date:** 2026-06-21
**Scope:** `lib/server/walletSnapshot.ts`, `app/api/wallet/route.ts`
**Mode:** Read-only audit. No logic, gating, caps, or provider behavior was changed in this pass.
**Goal:** Map every billable provider call, quantify cache/dedup behavior, and rank the top 10 credit consumers with exact code locations so a follow-up optimization pass has a precise target list.

---

## 1. How credits are modeled today

The per-scan credit model lives entirely in `walletSnapshot.ts` and is built from a static cost table plus a per-request call log.

### Credit table — `lib/server/walletSnapshot.ts:1763`
```
moralis:erc20_holdings                 1
moralis:erc20_transfers                1
goldrush:balances_v2                   1
goldrush:transactions_v3               1
goldrush:log_events_by_address         1
goldrush:historical_by_addresses_v2    1
alchemy:*                              0   (all Alchemy RPC priced at 0)
```

### Call log + dedup — `lib/server/walletSnapshot.ts:9437-9450`
```ts
const _apiCallLog: _ApiCallEntry[] = []
const _dupKeysSeen = new Set<string>()
const _trackCall = (provider, endpoint, cacheHit, dupKey) => {
  const duplicate = _dupKeysSeen.has(dupKey)
  if (!duplicate) _dupKeysSeen.add(dupKey)
  const credits = cacheHit || duplicate ? 0 : (CREDIT_TABLE[`${provider}:${endpoint}`] ?? 1)
  _apiCallLog.push({ provider, endpoint, credits, cacheHit, duplicate, dupKey })
  return duplicate
}
```
- `cacheHit || duplicate ⇒ 0 credits`. Cache-hit signal is supplied per call (e.g. Moralis `_mbRes.cacheHit`).
- Aggregated at `walletSnapshot.ts:12534-12660` into `_apiAudit` (`apiAudit.totalCredits`, per-provider `calls/credits/endpoints`, `duplicates`, `warnings`).
- Reconciled to the public budget in `route.ts:1320-1330` (`actualCreditsUsed = apiAudit.totalCredits`).

### Per-scan budget tiers — `walletSnapshot.ts:11440-11451`
```
target    = micro 6  | small 12 | standard/high_value/whale 15
hardCap   = micro 6  | everyone else 18   (admin override: 18 / WALLET_ADMIN_HISTORICAL_HARD_CAP)
historicalPhaseBudget = clamp(0..6, hardCap - creditsBeforeHistorical)
defaultPagesByTier    = micro 0 | others 1
```
Mirror in `route.ts:242-250` (`buildPublicWalletScanBudget`).

### Cache layers
| Layer | Location | TTL | Keying |
|---|---|---|---|
| In-process memory snapshot | `walletSnapshot.ts:9460-9488` (`snapshotMemCache`) | basic 5m / deep 60m / historical 24h (`route.ts:80-82`) | `addr:activity|holdings:schemaVersion` |
| Persistent (KV) snapshot | `route.ts:1011-1034` (`readPersistentWalletCache`) | same TTL tiers | same cacheKey |
| Historical-coverage result cache | `walletSnapshot.ts:11539-11558` (`historicalCoverageCache` + in-flight de-dupe) | `HISTORICAL_COVERAGE_TTL_MS` | addr + chainMode + tier + target contracts + pages |
| Shared receipt cache | `walletSnapshot.ts:2189-2221` (`sharedReceiptCache`) | 15m | rpc+txHash |
| Alchemy in-request dedup | `walletSnapshot.ts:9453` (`_alchemyDedup`) | request | method+addr+chain |

---

## 2. Complete billable call-site inventory

Every `_trackCall(...)` site, its endpoint cost, and what multiplies it. Alchemy sites included for completeness (priced 0 today — see Finding F2).

| # | Location | Provider:endpoint | Credit | Multiplicity driver |
|---|---|---|---|---|
| A | `9592` | goldrush:transactions_v3 (base activity) | 1 | once when `activityRequested` |
| B | `9593` | goldrush:transactions_v3 (eth eager) | 1 | once when ETH chain eager |
| C | `9720` | moralis:erc20_holdings | 1 **× active chains** | auto chain discovery fan-out |
| D | `9745-9746` | goldrush:balances_v2 (eth+base) | 2 | only when Moralis empty OR `deepScan` |
| E | `9789` | goldrush:transactions_v3 (eth deferred) | 1 | base_eth/all_supported with ETH value |
| F | `9996 / 10092 / 10160` | moralis:erc20_transfers (p1 / supplement / p19) | 1 each | multi-chain activity supplements |
| G | `10573-10574` | goldrush:historical_by_addresses_v2 (base pricing) | **1 × providerAttempts (≤ MAX_PRICE_ATTEMPTS = 10)** | unpriced swap legs |
| H | `10687` | goldrush:historical_by_addresses_v2 (unpriced recon) | 1 × pages | ETH/Base recon repricing |
| I | `10995` | moralis:erc20_transfers (fallback pages) | 1 × `fbPagesAttempted` | paginated activity fallback |
| J | `11165` | moralis:erc20_transfers (BFC pages) | 1 × `bfcPagesAttempted` | backfill-closed-lot pass |
| K | `11194` | goldrush:historical_by_addresses_v2 (BFC pricing) | 1 × pages | BFC repricing |
| L | `11566` | goldrush:log_events_by_address (historical broad) | 1 × pages (≤ hardCap remaining) | historical coverage expansion |
| M | `11675` | goldrush:log_events_by_address (synthetic-target extra) | 1 × `_syntheticTargetExtraPagesAllowed` | per-token recovery |
| N | `11786` | goldrush:historical_by_addresses_v2 (historical FIFO preview pricing) | 1 × pages | preview repricing |
| O | `9598-9606` | alchemy:getFirstTx / nonce / behavior | 0 | first-tx + nonce + behavior |
| P | `9847-9848` | alchemy:alchemy_getAssetTransfers | 0 | Base activity (deferred) |
| Q | `10346 / 10408 / 10467 / 10529 / 10673 / 10730` | alchemy:eth_getTransactionReceipt | 0 | **receipt fan-out across 5 recon passes** |
| R | `10533 / 10677` | alchemy:eth_getTransactionByHash | 0 | tx-by-hash recon |

Not tracked at all (Finding F1): **Zerion** `portfolio/` and `positions/` — `walletSnapshot.ts:9538` and `:9541`.

---

## 3. Top 10 credit consumers (ranked, worst-case per fresh scan)

Ranking is by worst-case billable credits on a cache-miss deep/historical scan of a multi-chain, low-coverage wallet (the expensive path the budget tiers exist to bound).

| Rank | Consumer | Location | Worst-case credits | Why it dominates |
|---|---|---|---|---|
| **1** | **Base price-at-time inference** (`historical_by_addresses_v2`) | `walletSnapshot.ts:10573-10574`, cap `MAX_PRICE_ATTEMPTS=10` @ `3997` | **up to 10** | One GoldRush historical call per unpriced swap leg; single largest GoldRush burn and loosely gated relative to the 15-credit target. |
| **2** | **Historical coverage broad pass** (`log_events_by_address`) | `walletSnapshot.ts:11565-11566`; pages `_pagesAllowedForBroadPass`/`11448-11451` | up to ~6 | Page loop bounded only by `hardCap - creditsBeforeHistorical`; the main "expansion" path. |
| **3** | **Synthetic-target extra recovery** (`log_events_by_address`) | `walletSnapshot.ts:11668-11680` | up to `_syntheticTargetExtraPagesAllowed` (≈2, historically up to 4 across chains) | Per-token recovery loop; separate budget bookkeeping (`_syntheticTargetExtraCreditUsed`) from path #2. |
| **4** | **Historical FIFO preview pricing** (`historical_by_addresses_v2`) | `walletSnapshot.ts:11786` | 1 × pages | Re-prices preview lots after the broad pass — additive on top of #1/#2. |
| **5** | **Backfill-closed-lot (BFC) pricing** (`historical_by_addresses_v2`) | `walletSnapshot.ts:11194` | 1 × `bfcPagesAttempted` | Third independent repricing path. |
| **6** | **Unpriced-recon pricing** (`historical_by_addresses_v2`) | `walletSnapshot.ts:10687` | 1 × pages | ETH/Base reconstruction repricing. |
| **7** | **Moralis activity transfers** (`erc20_transfers`) | `walletSnapshot.ts:9996 / 10092 / 10160 / 10995 / 11165` | 1 × paginated | Five distinct call sites; multi-chain supplements + fallback pagination compound. |
| **8** | **Activity transactions_v3** (base + eth eager/deferred) | `walletSnapshot.ts:9592 / 9593 / 9789` | up to 3 | One per chain; ETH eager + deferred can both fire. |
| **9** | **Moralis multi-chain holdings** (`erc20_holdings`) | `walletSnapshot.ts:9720` | 1 × active chains | Auto chain discovery (`9680-9705`) fans out one credit per discovered chain ≥ `minChainValueUsd=1`. |
| **10** | **GoldRush balances fallback** (`balances_v2` eth+base) | `walletSnapshot.ts:9745-9746` | 2 | Fires whenever Moralis holdings are empty or `deepScan`. |

**Aggregate observation:** ranks 1–6 are all *historical/pricing* GoldRush paths drawing from the same ≤18 hard cap through **six separate code paths** (`#1` base pricing, `#2` broad coverage, `#3` synthetic-extra, `#4` FIFO preview, `#5` BFC, `#6` unpriced recon). No single function owns "how much historical/pricing credit have we already spent" — the cap is enforced piecewise via `hardCap - creditsBeforeHistorical` subtractions, which is the root structural cost risk.

---

## 4. Cache-hit, duplicate, and expansion behavior

- **Memory/persistent snapshot cache** short-circuits *all* provider work (`walletSnapshot.ts:9461-9488`, `route.ts:1023-1034`) → 0 credits on hit. Basic 5m / deep 60m / historical 24h. This is the single biggest credit saver and works as intended.
- **Duplicate suppression** is correct: `_trackCall` credits a repeat `dupKey` as 0 (`9447`). Receipt recon deliberately re-records deduped hashes (`10346-10347`) — credited 0, but they **inflate `apiAudit.*.calls`/endpoint arrays**, which is why call-count warnings (`route.ts`/`12636-12639`) can read high even when credits are fine.
- **Historical-coverage result cache + in-flight de-dupe** (`11539-11558`) prevents two concurrent identical historical expansions from both paying — good.
- **Shared receipt cache** (15m, `2189-2221`) makes Alchemy receipt fan-out cheap on warm cache, but cold-cache deep scans still issue dozens of receipts (priced 0 — see F2).
- **Expansion fan-out:** historical recovery is *additive across* paths #2→#6. On a low-coverage wallet all can run in one scan; each subtracts from the same hard cap but is gated locally, so the realized total is emergent rather than centrally bounded.

---

## 5. Key findings (no changes made)

- **F1 — Zerion is a credit blind spot.** `portfolio/` + `positions/` fire on every cache-miss scan (`9538`, `9541`) but are absent from `CREDIT_TABLE` and never passed to `_trackCall`. They are invisible to `apiAudit.totalCredits` and to every budget warning. Per-scan credit estimates therefore understate true provider usage by 2 Zerion calls.
- **F2 — Alchemy priced at 0 hides real load.** All `alchemy:*` rows are 0 credits (`1770-1775`). Cold-cache recon (`Q`: six `eth_getTransactionReceipt` sites across five passes) can issue dozens of RPCs that the cost model reports as free. The credit estimate is a GoldRush/Moralis estimate, not a true provider-load estimate.
- **F3 — Pricing pass is the #1 burn and only locally capped.** `MAX_PRICE_ATTEMPTS = 10` (`3997`) can alone consume two-thirds of a 15-credit target before any historical expansion runs.
- **F4 — Six independent historical/pricing paths share one cap.** No single accumulator owns aggregate historical+pricing spend; the cap is enforced by repeated `hardCap - creditsBeforeHistorical` math at each site (`11447`, `11565`, `11622`). Hard to reason about, easy to regress.
- **F5 — Multi-chain holdings fan-out.** `erc20_holdings` is 1 credit **per active chain** (`9720`); `minChainValueUsd = 1` (`9655`) means even ~$1 chains pull a credit. Auto-discovery breadth directly scales holdings cost.
- **F6 — Call-count warnings vs. credit warnings diverge.** Because deduped/cached calls still append log entries, `apiAudit` call counts can trip provider-call warnings while `totalCredits` stays within target. Consumers reading call counts may over-report cost.

---

## 6. Suggested follow-up targets (for a later, change-making pass — not done here)

1. Track Zerion in `CREDIT_TABLE` + `_trackCall` so estimates are complete (F1).
2. Give Alchemy a non-zero internal "load unit" (even if 0 billable) so receipt fan-out is visible (F2).
3. Introduce one shared historical/pricing credit accumulator consulted by paths #1–#6 (F4).
4. Tighten/condition `MAX_PRICE_ATTEMPTS` by tier the way historical pages already are (F3).
5. Consider a value/coverage gate on per-chain holdings fan-out (F5).

No code in scope was modified in this audit pass.

---

## 7. Follow-up implementation pass (2026-06-21)

Items 1–4 above were implemented in a later pass on `lib/server/walletSnapshot.ts`:

- **F1 fixed:** `zerion:portfolio` / `zerion:positions` added to `CREDIT_TABLE` (1 credit each) and tracked via `_trackCall` right after the Phase 1 `Promise.allSettled` resolves.
- **F2 addressed:** `apiAudit.alchemy.loadUnits` now exposes the raw Alchemy call count alongside the (still 0) billable `credits`, so receipt/RPC fan-out stays visible even though it's free.
- **Cost breakdown added:** `apiAudit.costByPurpose` buckets live (non-cached, non-duplicate) credit spend into `holdings` / `activity` / `pricing` / `historical_recovery` / `portfolio` / `other`, surfaced to the API response via the existing `_diagnostics.apiAudit` passthrough in `route.ts`.
- **F4 fixed:** a single `_sharedHistoricalBudgetRemaining()` accumulator (established right after the base price-at-time pass, once `_creditsBeforeHistorical` is known) now backs every downstream historical/pricing path — broad coverage pages, synthetic-target extra pages, BFC re-pricing, unpriced-recon re-pricing, and FIFO preview pricing — replacing the previous per-site `hardCap - creditsBeforeHistorical` recomputation. `buildHistoricalPricingPreview`'s internal `MAX_PRICE_ATTEMPTS` (F3) is now an override capped by this same shared remaining budget instead of a fixed 10.
- **Duplicate pricing / failed-price caching:** `buildHistoricalPricingPreview` now calls `isGoldrushPriceCached` before charging a price-attempt slot (matching the pattern already used by `buildPriceAtTimeEvidence`), so a price already resolved — successfully or as a known failure — by an earlier pass no longer consumes a second budget slot. `buildWalletPnlRecoveryV2Base`'s WETH-leg price lookup is now threaded through the shared per-request `_reqPriceCache` instead of bypassing it.
- No scan-quality, evidence-standard, or PnL-accuracy regressions: every change either adds visibility (Zerion tracking, cost breakdown, load units) or removes genuinely redundant/wasted provider calls (shared budget, cache-aware price-attempt gating); no legitimate price lookup or recovery pass that would have found real evidence is skipped.
