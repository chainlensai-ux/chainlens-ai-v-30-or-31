// STEP 2 — pipelineOrchestrator V2 (runWalletScanV2)
//
// This does NOT modify or replace runWalletScan() (src/pipeline/index.ts) — it calls it unchanged,
// alongside the newly-promoted holdings/pricing/portfolio modules, and merges the results. The
// original Step 5 report from runWalletScan() is never mutated; V2's holdings/portfolio fields
// are additive alongside it.
//
// Supersedes the earlier sandbox file src/pipeline/runWalletScanWithHoldings.ts (removed as part
// of this promotion — nothing else referenced it besides app/api/scan-preview, which this step's
// app/api/scan-v2 route supersedes too).

import { runWalletScan } from './index'
import type { RunWalletScanParams, RunWalletScanResult } from './types'
import { validatePreScan } from './utils'

import { fetchHoldings } from '../modules/holdings/index'
import type { TokenHolding } from '../modules/holdings/types'
import { resolvePrices } from '../modules/pricing/index'
import type { PricingRequest, TokenPrice } from '../modules/pricing/types'
import { buildPortfolioSummary } from '../modules/portfolio/index'
import type { PortfolioSummary } from '../modules/portfolio/types'
import { createHoldingsKvWriter, withStageCache } from '../../lib/server/cache/v2StageCache'
import { NATIVE_ASSET_ADDRESS } from '../modules/providerFetchWindow/utils'

export type RunWalletScanV2Result = RunWalletScanResult & {
  holdings: TokenHolding[]
  portfolio: PortfolioSummary
}

function emptyPortfolio(): PortfolioSummary {
  return { totalValueUsd: null, tokens: [], chainValueBreakdown: [] }
}

// CANONICAL-BALANCE RECONCILIATION, DISCLOSED (found live, this task — confirmed architectural gap
// behind a false ~$545k unrealized PnL): `report` (via fifoEngine) and `holdings`/`portfolio` used
// to be computed FULLY INDEPENDENTLY in parallel and merged with zero cross-check — the file's own
// original header literally said "V2's holdings/portfolio fields are additive alongside it," which
// was true but meant fifoEngine's event-replay-derived open quantity for a token could silently
// diverge, without limit, from this SAME wallet's real current on-chain balance. Fixed by fetching
// holdings FIRST, building a real, sync canonical-balance lookup from it, and passing that into
// runWalletScan() so fifoEngine's own computePnl can exclude (never silently clamp) any token whose
// FIFO-derived open quantity fails to reconcile against this real balance BEFORE reporting
// unrealizedPnlUsd as official — see fifoEngine/types.ts's CanonicalBalanceLookup for the full
// mechanism.
//
// LATENCY TRADEOFF, DISCLOSED: holdings and the rest of the scan no longer run fully in parallel —
// holdings must resolve before fifoEngine's own pricing/PnL stage can consult it. This is a
// deliberate correctness-over-speed tradeoff, not a free win: a wallet whose holdings fetch is slow
// now adds that latency to the whole scan, rather than only to the holdings/portfolio fields. Same
// KV read-before/write-after caching (lib/server/cache/v2StageCache.ts) as before — fetchHoldings'
// own source is never touched, and the 20s TTL is unchanged.
// NATIVE-ASSET KEY NORMALIZATION, DISCLOSED (found live, this task — part of the "investigate
// missing_canonical_balance: distinguish genuinely absent holdings from token-key normalization
// mismatches" audit): GoldRush/Covalent's balances_v2 (this codebase's own holdings source — see
// src/modules/holdings/utils.ts) represents the chain's native asset (ETH) with the well-documented,
// standard Covalent convention of the all-zeros address, NOT this codebase's own NATIVE_ASSET_ADDRESS
// pseudo-address (0xeeee…eeee, used throughout providerFetchWindow/quoteLegPricing/fifoEngine for the
// SAME real asset). Without this alias, a native-ETH open FIFO lot (keyed by the 0xeeee… convention)
// would ALWAYS look up as `missing_canonical_balance` even when the wallet's real ETH balance is
// sitting right there in `holdings` under the zero-address key — a genuine key-format mismatch, not
// truly "no holdings evidence exists." This adds the SAME value under BOTH keys — it never merges two
// DIFFERENT real balances (a zero-address ERC20 token is not a legitimate deployable contract, so this
// alias can never collide with a genuine unrelated position), and it never fabricates a balance that
// wasn't already in the snapshot.
const NATIVE_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function nativeAliasKeys(chain: TokenHolding['chain'], contract: string): string[] {
  const lower = contract.toLowerCase()
  if (lower !== NATIVE_ZERO_ADDRESS) return [`${chain}:${lower}`]
  return [`${chain}:${lower}`, `${chain}:${NATIVE_ASSET_ADDRESS}`]
}

// CANONICAL-BALANCE RECONCILIATION, DISCLOSED (found live, this task — confirmed architectural gap
// behind a false ~$545k unrealized PnL): `report` (via fifoEngine) and `holdings`/`portfolio` used
// to be computed FULLY INDEPENDENTLY in parallel and merged with zero cross-check — the file's own
// original header literally said "V2's holdings/portfolio fields are additive alongside it," which
// was true but meant fifoEngine's event-replay-derived open quantity for a token could silently
// diverge, without limit, from this SAME wallet's real current on-chain balance. Fixed by fetching
// holdings FIRST, building a real, sync canonical-balance lookup from it, and passing that into
// runWalletScan() so fifoEngine's own computePnl can exclude (never silently clamp) any token whose
// FIFO-derived open quantity fails to reconcile against this real balance BEFORE reporting
// unrealizedPnlUsd as official — see fifoEngine/types.ts's CanonicalBalanceLookup for the full
// mechanism.
//
// LATENCY TRADEOFF, DISCLOSED: holdings and the rest of the scan no longer run fully in parallel —
// holdings must resolve before fifoEngine's own pricing/PnL stage can consult it. This is a
// deliberate correctness-over-speed tradeoff, not a free win: a wallet whose holdings fetch is slow
// now adds that latency to the whole scan, rather than only to the holdings/portfolio fields. Same
// KV read-before/write-after caching (lib/server/cache/v2StageCache.ts) as before — fetchHoldings'
// own source is never touched, and the 20s TTL is unchanged.
export function buildCanonicalBalanceLookup(holdings: TokenHolding[]): import('../modules/fifoEngine/types').CanonicalBalanceLookup {
  const byKey = new Map<string, number>()
  for (const h of holdings) {
    // A wallet can never hold a real NEGATIVE balance — a provider bug reporting one is not real
    // evidence of ANY balance, so it is treated the same as "unknown" (never coerced to 0, which
    // would incorrectly exclude every open lot for a token that might genuinely still be held).
    if (!Number.isFinite(h.amount) || h.amount < 0) continue
    for (const key of nativeAliasKeys(h.chain, h.contract)) {
      byKey.set(key, (byKey.get(key) ?? 0) + h.amount)
    }
  }
  return (token, chain) => byKey.get(`${chain}:${token.toLowerCase()}`) ?? null
}

// DIAGNOSTICS-ONLY METADATA, DISCLOSED: built from the SAME already-fetched `holdings` array as
// buildCanonicalBalanceLookup above — never an additional holdings fetch, never a provider call.
// Supplies only symbol/decimals/resolved-key for the reconciliation report; the balance itself (and
// therefore every include/exclude DECISION) still comes solely from the canonical balance lookup, so
// this can never change which positions are counted.
//
// RAW-BALANCE SAFETY, DISCLOSED: `TokenHolding.amountRaw` (the pre-decimal-normalization base-unit
// string) is deliberately NOT read here, and no field derived from it is exposed — only
// `tokenDecimals` (the metadata) and the already-normalized `amount` (used by the balance lookup)
// ever leave this file.
//
// `quarantined` IS NOT SET, DISCLOSED: TokenHolding carries no spam/quarantine/synthetic flag (see
// src/modules/holdings/types.ts — chain, contract, symbol, name, amount, amountRaw, tokenDecimals,
// providerPriceUsd, providerValueUsd, and nothing else), and this codebase's dust-suppression signal
// lives in a different stage that never reaches this snapshot. Rather than fabricate a flag, this
// lookup leaves `quarantined` unset — so the `synthetic_or_quarantined_position` reason is a real,
// wired-and-tested code path that simply never fires from THIS caller until a genuine quarantine
// signal exists to feed it.
export function buildCanonicalPositionMetadataLookup(
  holdings: TokenHolding[],
): import('../modules/fifoEngine/types').CanonicalPositionMetadataLookup {
  const byKey = new Map<string, import('../modules/fifoEngine/types').CanonicalPositionMetadata>()
  for (const h of holdings) {
    const metadata = {
      symbol: h.symbol ?? null,
      decimals: Number.isFinite(h.tokenDecimals) ? h.tokenDecimals : null,
      resolvedChain: h.chain,
      // Deliberately kept as the SNAPSHOT's own real address for each key — the zero-address alias
      // (see nativeAliasKeys above) still reports the snapshot's real (zero-address) contract here,
      // never rewritten to the pseudo-address, so a genuine chain_or_token_key_mismatch on the
      // NON-native alias key can never be masked by this alias.
      resolvedTokenAddress: h.contract,
    }
    for (const key of nativeAliasKeys(h.chain, h.contract)) {
      if (!byKey.has(key)) byKey.set(key, metadata)
    }
  }
  return (token, chain) => byKey.get(`${chain}:${token.toLowerCase()}`) ?? null
}

// CANONICAL CURRENT-PRICE LOOKUP, DISCLOSED (found live, this task — confirmed production evidence:
// totalOpenPositions: 60, reconciledOpenPositions: 0, every position excluded as
// missing_verified_current_price, currentPriceSource: null for all 60). ROOT CAUSE, AUDITED: the
// price previously fed into reconciliation came from priceLotsForWallet's HISTORICAL/at-trade-time
// pricing infrastructure — a completely different system from the already-resolved, already-approved
// `prices` this SAME file already computes for the portfolio total via resolvePrices(holdings). This
// lookup reuses that EXACT array (no second resolvePrices call, no new provider/DexScreener call —
// see the call site below) and reports its own real `.source` field as provenance, never a fabricated
// label. Matches buildPortfolioSummary's own resolution precedence exactly (provider-supplied price
// wins, since resolvePrices already encodes h.providerPriceUsd as priceUsd + source:'provider_supplied'
// whenever it was supplied — see pricing/index.ts's own resolvePrices).
export function buildCanonicalCurrentPriceLookup(
  holdings: TokenHolding[],
  prices: TokenPrice[],
): import('../modules/fifoEngine/types').CanonicalCurrentPriceLookup {
  const byKey = new Map<string, import('../modules/fifoEngine/types').CanonicalCurrentPriceResult>()
  for (const p of prices) {
    // UNAVAILABLE IS NOT A PRICE, DISCLOSED: resolvePrices reports `source: 'unavailable'` with
    // `priceUsd: null` when nothing was found — never indexed here, so a caller correctly sees
    // "no canonical price" (null) rather than a fabricated 0/undefined-source entry.
    if (p.priceUsd == null || !Number.isFinite(p.priceUsd) || p.priceUsd <= 0) continue
    const result = { priceUsd: p.priceUsd, source: p.source }
    for (const key of nativeAliasKeys(p.chain, p.contract)) {
      if (!byKey.has(key)) byKey.set(key, result)
    }
  }
  // Defensive fallback to each holding's OWN providerPriceUsd, in case a (chain, contract) pair
  // exists in `holdings` but was somehow never represented in `prices` (e.g. a caller passing a
  // trimmed prices array) — mirrors buildPortfolioSummary's own `h.providerPriceUsd ?? ...`
  // precedence exactly, never a second/different price system.
  for (const h of holdings) {
    if (h.providerPriceUsd == null || !Number.isFinite(h.providerPriceUsd) || h.providerPriceUsd <= 0) continue
    const result = { priceUsd: h.providerPriceUsd, source: 'provider_supplied' }
    for (const key of nativeAliasKeys(h.chain, h.contract)) {
      if (!byKey.has(key)) byKey.set(key, result)
    }
  }
  return (token, chain) => byKey.get(`${chain}:${token.toLowerCase()}`) ?? null
}

// Never mutates the report runWalletScan() returns — holdings/portfolio are computed
// independently and merged into a new object at the end.
export async function runWalletScanV2(params: RunWalletScanParams): Promise<RunWalletScanV2Result> {
  const preScan = validatePreScan(params)
  const holdingsKvWriter = createHoldingsKvWriter()

  // KV read-before/write-after (lib/server/cache/v2StageCache.ts) — pipeline-level caching only,
  // fetchHoldings' own source is never touched. 20s TTL: shortest of the 4 wrapped stages, since
  // current balances are the most time-sensitive of the cached data (a stale balance is more
  // visibly wrong to a user than a slightly-stale historical event window).
  const holdingsResults = preScan.valid
    ? await Promise.all(preScan.sanitizedChains.map((chain) =>
        withStageCache(
          `v2:holdings:${chain}:${params.walletAddress.toLowerCase()}`,
          20,
          () => fetchHoldings(chain, params.walletAddress),
          { writer: holdingsKvWriter },
        ),
      ))
    : []

  const holdings: TokenHolding[] = holdingsResults.flatMap((r) => r.holdings)

  // SEQUENCING FIX, DISCLOSED (found live, this task — confirmed root cause of currentPriceSource
  // being null for every position): prices used to be resolved AFTER runWalletScan() had already
  // run and returned — reconciliation was structurally starved of prices that didn't exist yet at
  // the time it ran. Resolved BEFORE the scan now, from the exact same already-fetched `holdings`
  // snapshot, and reused (never recomputed) for the portfolio total below — no additional
  // resolvePrices()/DexScreener/provider call is added anywhere.
  let prices: TokenPrice[] = []
  try {
    const pricingRequests: PricingRequest[] = holdings.map((h) => ({
      chain: h.chain,
      contract: h.contract,
      knownPriceUsd: h.providerPriceUsd,
    }))
    prices = await resolvePrices(pricingRequests)
  } catch {
    prices = []
  }

  const report = await runWalletScan({
    ...params,
    canonicalBalanceLookup: buildCanonicalBalanceLookup(holdings),
    unrealizedReconciliationDiagnostics: {
      positionMetadataLookup: buildCanonicalPositionMetadataLookup(holdings),
      canonicalCurrentPriceLookup: buildCanonicalCurrentPriceLookup(holdings, prices),
      // No per-token current-price SOURCE lookup separate from the canonical one above is needed —
      // canonicalCurrentPriceLookup's own `.source` field is preferred whenever present (see
      // computePnl's own "CANONICAL PRICE PREFERENCE" comment), so this legacy field is left unset.
    },
  })

  let portfolio: PortfolioSummary
  try {
    portfolio = buildPortfolioSummary(holdings, prices)
  } catch {
    portfolio = emptyPortfolio()
  }

  return { ...report, holdings, portfolio }
}
