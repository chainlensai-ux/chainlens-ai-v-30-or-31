# Capability — PnL Engine

**Source:** `lib/server/clarkRouting.ts` (~lines 763–906), `lib/server/walletIntelligence.ts` (~lines 60–67)

## Data sources

- `walletTradeStatsSummary` — `publicPnlStatus`, `publicClosedLots`, `publicWinRatePercent`, `publicRealizedPnlUsd`
- `estimatedPerformanceRead` — estimated PnL with an explicit confidence level
- `publicSamplePerformanceRead` — limited-sample PnL below the public-grade threshold

## Public-grade threshold

`REQUIRED_PUBLIC_GRADE_LOTS = 10` (`clarkRouting.ts` ~line 731). A wallet's PnL is only shown as verified once it has at least 10 public-grade closed lots.

## Lock conditions (PnL is withheld / hedged when any of)

- `publicPnlStatus !== 'ok'`
- `pnlIntegrityStatus === 'invalid'`
- `publicClosedLots < 10`

## Display modes

- `verified_public` — ≥10 public-grade lots, integrity ok, status `'ok'`
- `limited_sample` — 1–9 public-grade lots (below threshold)
- `estimated_only` — estimated PnL present but unverified; excluded from win_rate, profit_skill, wallet_score
- `locked` — insufficient data for any PnL claim

## Profit-skill lock conditions (`walletIntelligence.ts`)

Profit-skill scoring is locked when:
- `publicPnlStatus` is one of `open_check`, `near_flat_verified_sample`, `activity_only`, `missing_cost_basis`, `limited_verified_sample`
- `performanceClosedLots < 10`
- `pnlIntegrityStatus === 'invalid'`

## Hard rule

Clark never states "this wallet is profitable" or "unprofitable" as a flat claim — only the PnL **status** (`verified`, `partial`/`limited_sample`, or `locked`) is surfaced. See [[Public-Grade-Filtering]].
