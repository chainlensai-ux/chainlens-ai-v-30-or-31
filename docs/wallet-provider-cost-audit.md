# Wallet Scanner — Alchemy / GoldRush cost audit

Scope audited: `app/api/wallet*/**`, `app/api/_shared/walletChainPipeline.ts`,
`lib/server/walletSnapshot.ts`, `src/pipeline/**`, `src/modules/providerFetchWindow/**`,
`src/modules/holdings/**`, `src/modules/recoveryPolicy/**`, `src/modules/receiptSwapDecoder/**`,
`src/modules/pricingAtTimeEngine/**`, `lib/server/alchemyCallBudget.ts`.

Method: every provider call site was located by grepping for the real network primitives
(`alchemy_getAssetTransfers`, `alchemy_getTokenBalances`, `api.covalenthq.com/...`,
`PricingService.getTokenPrices`, `client.call`/`readContract` against Alchemy RPC URLs) and read in
place. CU/credit figures are Alchemy's published per-method costs (already encoded in
`lib/server/alchemyCallBudget.ts`) and Covalent's per-request credit model. Counts marked
"measured" come from disclosed production evidence already recorded in the codebase's own headers;
everything else is marked "structural" (derived from reading the code, not from a live scan).

---

## A. Call inventory

| # | Caller (file / function) | Provider · endpoint | Chain | Trigger | Calls/scan | Pages | Est. cost | Cache / singleflight | Output used? | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `providerFetchWindow/utils.fetchGoldrushRawEvents` | GoldRush `transactions_v3` | per chain | every scan | 1 / chain | 1 (hard, no paging) | ~1 credit | request-scoped singleflight + settled reuse (`fetchProviderWindow`) | yes | **OK** — already single-fetch-per-chain |
| 2 | `providerFetchWindow/utils.fetchAlchemyRawEvents` | Alchemy `alchemy_getAssetTransfers` | per chain | every scan | 2 / chain (from+to) | bounded | 150 CU × 2 | same singleflight as #1 | yes | **OK** |
| 3 | `holdings/utils` | GoldRush `balances_v2` | per chain | holdings stage | 1 / chain | 1 | ~1 credit | none needed (1 call) | yes | **OK** |
| 4 | `holdings/utils` | Alchemy `alchemy_getTokenBalances` | per chain | holdings stage | 1 / chain | 1 | 26 CU | none needed | yes | **OK** |
| 5 | `recoveryPolicy/utils.fetchGoldrushHistoricalPage` | GoldRush `transactions_v3` (page N) | per chain | per *triggered* recovery candidate | 1 / (chain,page) | capped by caller | ~1 credit/page | request-scoped map, reset per job | yes | **OK** since the coalescing fix; page 0 overlap with #1 noted below |
| 6 | `recoveryPolicy/utils.fetchAlchemyTokenHistory` | Alchemy `alchemy_getAssetTransfers` (contract-scoped) | per chain | per triggered candidate | 2 / candidate | bounded `maxCount 0x64` | 150 CU × 2 × candidates | **none** | yes | **UNBUDGETED** — scales with candidate count |
| 7 | `pricingAtTimeEngine/sources/goldrushPriceSource` | GoldRush `PricingService.getTokenPrices` | all | every priced entry | **1,045 measured** in one real scan | n/a | ~1 credit each | negative cache (per chain+token, 5 min TTL), in-flight singleflight (chain+token+date), consecutive-miss breaker | often **no** (`primary: 0` accepted in the measured scan) | **WORST OFFENDER** |
| 8 | `pricingAtTimeEngine/sources/basedex` (Uniswap V3 / Aerodrome ×2) | Alchemy RPC `eth_call` / `eth_getBlockByNumber` | base | historical on-chain pricing | **1,483 measured** (V3 alone), pre-containment | n/a | 16–26 CU each | now hard-capped | partially | **FIXED last task** — `historicalRpcBudget`, default OFF |
| 9 | `pricingAtTimeEngine/sources/alchemyHistoricalPriceSource` | Alchemy Prices API | all | shadow mode only | ≤10 / scan | n/a | 40 CU each | own per-scan budget + negative cache | shadow only | **OK** (bounded, gated) |
| 10 | `receiptSwapDecoder/rpcClient` | Alchemy `eth_getTransactionReceipt` | base | Phase-2 receipt completion | ≤40 (`MAX_CONDITIONAL_RECEIPT_BUDGET`) | n/a | 15 CU each | permanent receipt cache + singleflight | yes | **OK** (bounded) |
| 11 | `lib/server/walletSnapshot.ts` (many sites) | Alchemy `alchemy_getAssetTransfers` | eth+base | dev-wallet / token-intel surface | many | some paginated | 150 CU each | ad-hoc `_alchemyDedup` set | yes | **out of PnL scan path** — see §C |
| 12 | `pipeline/index.safeRunPricingAtTime` (stage 6c) | via #7/#8 chain | all | display-only pass | 1 pass | n/a | inherits | inherits | display only | see §B.4 |
| 13 | `priceLotsForWallet` "current price" pass (`atNow`) | via #7/#8 chain | all | every scan | 1 per distinct held token | n/a | inherits | inherits | yes | see §B.4 |

---

## B. Proven waste (with evidence)

### B.1 — Verified stablecoin legs pay a full four-provider fallback chain. **[fixed]**

`isVerifiedStablecoinAddress` exists and is correct, but grepping every call site shows it is used
**only** for asset-class labelling in `pricingAtTimeAdapter.ts:51` (the success-evidence model) and
inside `quoteLegPricing`/`basedex` for quote-leg maths. **Nothing in the price-resolution path ever
consults it to avoid a call.**

Consequence, structural and certain: a USDC leg entering `resolvePricingAtTime` is routed through
`buildChainAwareHistoricalPriceSourceDetailed`, which tries — in order — GoldRush, DexScreener,
GeckoTerminal, then the `getPriceAtTime` safety net (CoinGecko + basedex). Every one of those is a
real network call, made to discover that USDC is worth ~$1.00.

This is not a marginal case. Every swap produces a quote leg, and on Base/ETH the dominant quote
assets are USDC/USDbC/DAI/USDT. `priceLotsForWallet` builds a `PriceableEntry` for *every* merged
inbound/outbound event, so a wallet whose trades are USDC-quoted sends roughly one stablecoin leg
per trade into the full chain.

The same codebase already treats a verified stablecoin as exactly $1 without a provider call, in
`basedex.convertQuoteRatioToUsd` — so this fix applies an existing, already-accepted convention at
the router entry instead of inventing a new evidence standard.

### B.2 — `lib/server/alchemyCallBudget.ts` is entirely unwired. **[fixed]**

The module is complete, documented, and has its own passing test file — and has **zero production
call sites**. Grep for `createAlchemyCallBudget` outside its own test returns nothing. Requirements
1 and 5 ("one request-scoped provider budget shared across the entire wallet scan", "hard-stop all
Alchemy paths when their call/CU budget is exhausted") were therefore not enforced anywhere.

### B.3 — GoldRush pricing has no hard call cap. **[fixed]**

`goldrushPriceSource` has a negative cache, in-flight singleflight, an 8 s timeout, and a
consecutive-miss circuit breaker (threshold 20, cooldown 30 s). It has **no ceiling on total calls
per scan.** The breaker re-closes after 30 s and the source resumes at full cost; the codebase's own
header records a real scan making **1,045 calls with `primary: 0` accepted**. A breaker bounds
*latency*, not *spend*.

### B.4 — Recovery Alchemy pulls are unbudgeted (#6 above)

`fetchAlchemyTokenHistory` makes 2 × `alchemy_getAssetTransfers` (300 CU) per triggered candidate
with no budget check and no cache. Unlike its GoldRush sibling it has no request-scoped coalescing.

---

## C. Deliberately **not** changed, with reasons

- **`lib/server/walletSnapshot.ts` (20.5k lines, item #11).** This is the dev-wallet / token-intel
  surface (`/api/dev-wallet`, `/api/wallet-scanner`), *not* the PnL wallet-scan pipeline. It has its
  own `_alchemyDedup` set. Rewiring 20k lines of a separate product surface onto the scan budget is
  not a surgical change and cannot be validated by the wallet tests this task scopes. Flagged for a
  follow-up task rather than half-done here.
- **Requirement 6 ("remove block bisection, fee-tier fan-out, per-requirement RPC loops").** Already
  completed in the previous task (`historicalRpcBudget`, single-correction-read block resolution,
  multicall'd fee tiers). Verified still in place; no further change needed.
- **Requirement 2 ("one Base and one ETH history fetch").** Already satisfied by
  `fetchProviderWindow`'s request-scoped singleflight + settled-reuse map, which both the old
  pipeline and the V2 engine route through. Verified by reading both call sites; a regression test
  is added rather than new machinery.
- **Requirement 9 page-0 overlap.** `recoveryPolicy` page 1+ never re-fetches page 0, and the base
  window fetch uses a different endpoint shape. Overlap is structural, not duplicative — left alone
  rather than risking a behaviour change to recovery coverage on an unproven theory.
- **Requirements 13, 16.** Already true: the router returns on first accepted price, and every
  budget/miss path resolves to `null` rather than a fabricated value. Locked in with assertions.

---

## D. Fixes implemented

1. `walletProviderCostLedger.ts` — one request-scoped ledger + budget shared by Alchemy and
   GoldRush across the whole scan, with per-endpoint / per-chain / per-stage attribution,
   duplicate-prevented and capped counters, and the `[wallet-provider-cost-audit]` diagnostic.
2. Verified-stablecoin short-circuit at the price-router entry (B.1) — deterministic $1.00, zero
   provider calls, recorded as a prevented duplicate.
3. Hard per-scan GoldRush pricing call cap (B.3), fail-closed to `null`.
4. Budget gate on the recovery Alchemy pull (B.4).
