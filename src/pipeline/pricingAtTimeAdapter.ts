// MODULE (orchestration layer) — pricingAtTimeAdapter
//
// Composes this pipeline's real price sources into pricingAtTimeEngine's two-slot PriceSources
// contract (src/modules/pricingAtTimeEngine/types.ts's `{ primary, fallback }` — never modified
// here).
//
// CHAIN-AWARE ROUTING, DISCLOSED (per this task's own request): GoldRush historical pricing is
// tried first for every chain EXCEPT Base, where GeckoTerminal is tried first instead; DexScreener
// (current-price-only, never historical — see its own module header) sits in the middle for both;
// whichever of GoldRush/GeckoTerminal wasn't tried first runs last. FALSE PREMISE IN THE REQUEST,
// DISCLOSED: the request assumed "GoldRush will return null for Base" — that's not true. GoldRush's
// real chain-slug map (src/modules/pricingAtTimeEngine/sources/goldrushPriceSource.ts's
// GOLDRUSH_CHAIN_SLUGS) has genuine, verified coverage for Base (`base-mainnet`). It is still tried
// last for Base per this request (a legitimate "prefer free sources first" choice) — it just may
// genuinely return a real price rather than null.
//
// COVERAGE PRESERVED, DISCLOSED (explicit user confirmation this session): the literal 3-provider
// ordering below never mentions CoinGecko or the on-chain Uniswap V3 source (basedex) — both
// currently provide real coverage via multiProviderPriceSource. Rather than silently dropping that
// coverage (a real regression, not just a reorder), both run as one final fallback attempt after
// GoldRush/DexScreener/GeckoTerminal have all failed, for every chain.
//
// SCOPE NOTE, DISCLOSED: no new "dexScreenerPriceSource.ts" historical source was built (from the
// prior task in this session). DexScreener already runs inside multiProviderPriceSource (protected,
// src/modules/pricingAtTimeEngine/sources/multiProviderPriceSource.ts -> dexscreener.ts) and that
// module's own header already discloses it as current-price-only — DexScreener's real public API
// has no historical OHLCV endpoint. This file calls that same real, existing function directly
// (not a new integration) wherever "DexScreener" appears in the routing below.

import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'
import type { SupportedChain } from '../modules/providerFetchWindow/types'
import { getPriceAtTime } from '../modules/pricingAtTimeEngine/sources/multiProviderPriceSource'
import { fetchGeckoTerminalPriceDetailed } from './providers/geckoTerminalPriceSource'
import { fetchDexscreenerPriceShared } from '../lib/dexscreenerRequestCache'
import { DEXSCREENER_FRESHNESS_TOLERANCE_MS, isDexscreenerSupportedChain } from '../modules/pricingAtTimeEngine/sources/dexscreener'
import { isGoldrushCircuitOpen } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { fetchBaseDexPriceDetailed } from '../modules/pricingAtTimeEngine/sources/basedex'
import { fetchCoingeckoNativeEthPriceDetailed } from '../modules/pricingAtTimeEngine/sources/coingecko'
import {
  recordPricingAttemptOutcome, routeSourceOrderFor, type PricingAssetClass,
} from '../modules/pricingAtTimeEngine/sourceSuccessEvidence'
import { recordDuplicatePrevented } from '../modules/providerCost/walletProviderCostLedger'
import {
  isNativePseudoAddress, isCanonicalWethAddress, isVerifiedStablecoinAddress,
} from '../modules/quoteLegPricing/index'

// Classifies the asset a price was requested for, using the SAME address-based checks the rest of
// this pipeline already uses — never a symbol heuristic, never a guess. 'other' is the honest
// default for anything not in one of the two verified classes.
function evidenceAssetClassFor(chain: SupportedChain, token: string): PricingAssetClass {
  if (isNativePseudoAddress(token) || isCanonicalWethAddress(chain, token)) return 'native'
  if (isVerifiedStablecoinAddress(chain, token)) return 'stable'
  return 'other'
}

// ETH NATIVE ROUTING MISMATCH, DISCLOSED (confirmed production evidence: the two selected Ethereum
// native-quote requirements, correctly routed to the canonical WETH-on-mainnet contract address,
// both returned resolvedPriceUsd: null, while two Base native requirements — routed the same way, to
// Base's own canonical WETH contract — priced successfully). Audited: Base's extra success comes
// from basedex.ts's on-chain Uniswap V3 fallback, which ONLY supports 'base'
// (`fetchBaseDexPriceDetailed` returns `base_dex_only_supports_base_chain` for every other chain,
// confirmed by reading its own gate) — not something addable here without a real mainnet on-chain
// integration, out of scope for a routing fix. The genuinely fixable mismatch: every existing source
// queries WETH by ITS CONTRACT ADDRESS uniformly, including CoinGecko's contract-based
// `/coins/{platform}/contract/{address}/market_chart/range` endpoint — a secondary, contract-derived
// dataset that can genuinely have date gaps a token's OWN coin-id history does not. CoinGecko
// separately indexes native ETH under its own real, documented coin id ("ethereum") via
// `/coins/ethereum/history` — the SAME asset this pseudo-address-routed-to-WETH price is standing in
// for, priced through its PRIMARY dataset instead of the secondary contract-derived one. This constant
// is the well-known canonical WETH-on-mainnet address (the exact one quoteLegPricing/index.ts already
// routes the native pseudo-address to for chain 'eth') — recognized here as "this specific address on
// this specific chain is functionally native ETH," not a general WETH-detection mechanism.
const ETH_CANONICAL_WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

// PER-REQUIREMENT AUDIT LOG, DISCLOSED, ADDITIVE — process-lifetime, same cross-request-leak-guard
// snapshot (length-before/slice-after) convention as pricingRouteLog below. One entry per real
// attempt at this specific (chain 'eth', canonical WETH) address, carrying every field
// coingecko.ts's own diagnostic already computed (breaker state, HTTP status, response shape,
// parsed price, exact failure reason) plus what THIS layer additionally knows: which fallback
// sources were subsequently attempted after the native route missed. `txHash` is left null here —
// this layer never sees it (PriceSourceFn is (token, chain, timestamp) only) — a caller that knows
// the txHash for a given timestamp (priceLotsForWallet.ts, which owns that mapping for its own
// native-quote requirements) can correlate by `originalTimestamp` and attach it.
export type EthNativeRoutingAuditEntry = {
  chain: SupportedChain
  originalContract: string
  diagnostic: import('../modules/pricingAtTimeEngine/sources/coingecko').NativeEthPricingDiagnostic
  fallbackSourcesAttempted: PriceAttemptDetail[]
}
export const ethNativeRoutingAuditLog: EthNativeRoutingAuditEntry[] = []

// Sanity guard, applied to every price this pipeline resolves — a price outside this range is
// provider garbage, never rendered. Independent of pnlSummaryAdapter.ts's separate $1e12
// PnL-overflow guard.
const MIN_VALID_USD_PRICE = 0
const MAX_VALID_USD_PRICE = 1e6

export function isSanePrice(price: number | null | undefined): price is number {
  return price != null && Number.isFinite(price) && price > MIN_VALID_USD_PRICE && price <= MAX_VALID_USD_PRICE
}

// Wraps any existing PriceSourceFn so an out-of-range result is discarded (logged, treated as no
// data) instead of ever reaching fifoEngine/pnlEngine's real cost-basis calculations. Kept exported
// — still used standalone in src/pipeline/index.ts for defense-in-depth around the GoldRush client
// construction path.
export function withSanePriceGuard(source: PriceSourceFn, sourceLabel: string): PriceSourceFn {
  return async (token, chain, timestamp) => {
    const result = await source(token, chain, timestamp)
    if (result === null) return null
    if (isSanePrice(result)) return result
    // eslint-disable-next-line no-console
    console.warn('[pricingAtTimeAdapter] out-of-range price discarded', { sourceLabel, token, chain, price: result })
    return null
  }
}

// Extends an existing fallback source (multiProviderPriceSource — DexScreener/CoinGecko/basedex,
// all real, already integrated) with GeckoTerminal as one more real historical attempt when the
// existing chain comes up empty. Never replaces the existing chain, only extends it. Kept exported
// for any caller still using the simpler (non-chain-aware) composition.
export function withGeckoTerminalFallback(existingFallback: PriceSourceFn): PriceSourceFn {
  return async (token, chain, timestamp) => {
    const fromExisting = await existingFallback(token, chain, timestamp)
    if (fromExisting !== null) return fromExisting

    const geckoResult = await fetchGeckoTerminalPriceDetailed(token, chain, timestamp)
    return geckoResult.priceUsd
  }
}

// 'verified_stablecoin' is a real, distinguishable route, DISCLOSED: a deterministic $1.00 for an
// address-verified USD-pegged stablecoin, resolved with ZERO provider calls (see the short-circuit
// in buildChainAwareHistoricalPriceSourceDetailed below). Kept as its own route value — never
// folded into an existing provider's label — so a reader of pricingRouteLog can always tell a
// deterministic resolution apart from one a real provider actually answered.
export type PricingRouteUsed = 'goldrush' | 'geckoterminal' | 'dexscreener' | 'coingecko_or_basedex' | 'coingecko_native_eth' | 'verified_stablecoin' | 'none'

// A verified, address-checked USD-pegged stablecoin is priced at exactly $1.00 — the same
// deterministic convention basedex's convertQuoteRatioToUsd already applies to a verified
// stablecoin quote leg. Named rather than inlined so every use site is greppable.
export const VERIFIED_STABLECOIN_USD = 1

export type PricingRouteRecord = {
  token: string
  chain: SupportedChain
  timestamp: number
  route: PricingRouteUsed
}

// Process-lifetime, cross-request log of which real provider actually answered each pricing
// attempt — same disclosed in-memory pattern as lib/server/rpcDebug.ts's rpcDebugLog elsewhere in
// this codebase. A per-request view requires the same snapshot-length-before/slice-after pattern
// already used around rpcDebugLog in src/pipeline/index.ts.
export const pricingRouteLog: PricingRouteRecord[] = []

function recordRoute(token: string, chain: SupportedChain, timestamp: number, route: PricingRouteUsed): void {
  pricingRouteLog.push({ token, chain, timestamp, route })
}

// DETAILED ATTEMPT RECORD, DISCLOSED (provider-call-audit follow-up task): every source function
// below (dexscreener.ts, geckoTerminalPriceSource.ts, multiProviderPriceSource.ts's own
// dexscreener/coingecko/basedex trio) ALREADY computes a real, structured rejection `reason` string
// per attempt — this router previously discarded every one of them the instant it checked
// `price !== null`, keeping only the final winning/losing boolean. That is the confirmed reason this
// pipeline could not distinguish "unsupported chain" from "no pool" from "provider genuinely has no
// data" — the information already existed, one layer up, and was thrown away for free. Capturing it
// here costs zero additional network calls: it's the exact same real calls this router always made,
// just no longer discarding what they already told it.
export type PriceAttemptDetail = { source: 'goldrush' | 'dexscreener' | 'geckoterminal' | 'coingecko' | 'base_dex'; ok: boolean; reason: string | null }
export type ChainAwareHistoricalPriceResult = { price: number | null; route: PricingRouteUsed; attempts: PriceAttemptDetail[] }

// BASE-DEX PRIORITISATION, DISCLOSED (source-retry-avoidance task, explicit "prioritise Base DEX
// first for Base historical candidates where it has already demonstrated success" requirement):
// BaseDex (basedex.ts's on-chain Uniswap V3 read) previously only ever ran as the LAST resort, inside
// the safety net, after GeckoTerminal/DexScreener/GoldRush had all already failed for every single
// Base candidate — even on a scan where BaseDex has ALREADY proven it has real, current data for this
// wallet's tokens (Base's own native DEX liquidity is often deeper/more current than any of the
// three sources ahead of it). Tracked per-scan (module-level, reset alongside every other per-job
// state — see resetPricingAtTimeAdapterScanState below): the FIRST time BaseDex succeeds for ANY Base
// candidate in this scan, every SUBSEQUENT Base candidate tries BaseDex FIRST, before
// GeckoTerminal/DexScreener/GoldRush — never changing which sources exist or their own internal
// price-selection/validation rules, only the ORDER a demonstrably-working one is tried in.
let baseDexProvenThisScan = false

// PER-SCAN RESET, DISCLOSED: same convention as every other request-scoped/scan-scoped state in
// this codebase — called once per real scan (src/modules/walletScanWorker.ts) so a warm serverless
// instance's PREVIOUS scan (a different wallet, possibly on a different chain) never silently biases
// this scan's own source ordering.
export function resetPricingAtTimeAdapterScanState(): void {
  baseDexProvenThisScan = false
}

// TEST-SUPPORT EXPORT, DISCLOSED: read-only observability, same convention as this codebase's other
// scan-scoped state (isGoldrushBreakerOpenForTest, isCoingeckoCircuitOpenForTest).
export function isBaseDexProvenThisScanForTest(): boolean {
  return baseDexProvenThisScan
}

// Builds the full chain-aware historical-pricing router described above. `goldrush` is the
// caller's real (or always-null, if no API key/client) GoldRush source — this function does not
// construct a GoldRushClient itself.
//
// DETAILED VARIANT, ADDITIVE: exported for diagnostic callers (currently
// src/lib/pnlReconciliation.ts's recovery pass) that want the real per-source rejection reasons
// alongside the price — never a second/duplicate call, this IS the one real call path; the plain
// `buildChainAwareHistoricalPriceSource` below is now a thin wrapper over this same function.
export function buildChainAwareHistoricalPriceSourceDetailed(
  goldrush: PriceSourceFn,
): (token: string, chain: SupportedChain, timestamp: number) => Promise<ChainAwareHistoricalPriceResult> {
  // STRUCTURALLY-UNSUPPORTED SKIP, DISCLOSED (source-retry-avoidance task, "skip GoldRush for
  // token/chain classes already returning unsupported" requirement): once GoldRush's OWN circuit
  // breaker has opened (goldrushPriceSource.ts, after GOLDRUSH_BREAKER_THRESHOLD consecutive misses
  // within this same process), the underlying call already short-circuits to null at effectively
  // zero cost — but this router previously still spent an await + its place in the ordering
  // attempting it anyway, on every remaining candidate. Skipping the attempt outright, instead of
  // one layer down, means a source GoldRush's own breaker has just proven isn't answering no longer
  // occupies a slot in the ordering ahead of sources that still might. Same real breaker state
  // either way — never a second, separate circuit.
  const tryGoldrush = async (token: string, chain: SupportedChain, timestamp: number): Promise<PriceAttemptDetail & { price: number | null }> => {
    if (isGoldrushCircuitOpen()) return { source: 'goldrush', ok: false, reason: 'goldrush_no_data', price: null }
    const price = await goldrush(token, chain, timestamp)
    // goldrushPriceSource.ts has no detailed/reason-carrying variant (plain PriceSourceFn only) —
    // an honest, disclosed limitation: every one of its own null-producing branches (unverified
    // chain, unparseable timestamp, breaker open, negative-cache hit, empty/error response,
    // non-numeric price) collapses to this one generic reason, never a fabricated specific one.
    return isSanePrice(price) ? { source: 'goldrush', ok: true, reason: null, price } : { source: 'goldrush', ok: false, reason: 'goldrush_no_data', price: null }
  }
  // STRUCTURALLY-UNSUPPORTED SKIP, DISCLOSED ("skip DexScreener for historical timestamps it cannot
  // serve" requirement): DexScreener's own public API is current-price-only (see dexscreener.ts's
  // own header) — its real implementation ALREADY rejects any timestamp older than
  // DEXSCREENER_FRESHNESS_TOLERANCE_MS with zero network call. Hoisting the identical check here
  // means this router doesn't even pay the shared-cache lookup/coalescing overhead for a timestamp
  // already known, deterministically, to be outside what this source can ever serve — same real
  // gate dexscreener.ts itself already enforces, evaluated one layer earlier. A recovery candidate
  // is virtually always historical (a real past trade), so this is the common case, not an edge one.
  const tryDexscreener = async (token: string, chain: SupportedChain, timestamp: number): Promise<PriceAttemptDetail & { price: number | null }> => {
    // PRECEDENCE, DISCLOSED: mirrors dexscreener.ts's own real check order exactly (chain-support
    // check first, freshness check second) — an unverified chain must still report
    // 'unverified_chain_for_dexscreener', never be shadowed by the freshness skip below, for a chain
    // this source was never going to support regardless of timestamp.
    if (isDexscreenerSupportedChain(chain) && Math.abs(Date.now() - timestamp) > DEXSCREENER_FRESHNESS_TOLERANCE_MS) {
      return { source: 'dexscreener', ok: false, reason: 'dexscreener_only_exposes_current_price_timestamp_too_far_from_now', price: null }
    }
    const result = await fetchDexscreenerPriceShared(token, chain, timestamp, 'historical')
    return isSanePrice(result.priceUsd)
      ? { source: 'dexscreener', ok: true, reason: null, price: result.priceUsd }
      : { source: 'dexscreener', ok: false, reason: result.reason, price: null }
  }
  const tryGeckoTerminal = async (token: string, chain: SupportedChain, timestamp: number): Promise<PriceAttemptDetail & { price: number | null }> => {
    const result = await fetchGeckoTerminalPriceDetailed(token, chain, timestamp)
    return isSanePrice(result.priceUsd)
      ? { source: 'geckoterminal', ok: true, reason: null, price: result.priceUsd }
      : { source: 'geckoterminal', ok: false, reason: result.reason, price: null }
  }
  const tryBaseDex = async (token: string, chain: SupportedChain, timestamp: number): Promise<PriceAttemptDetail & { price: number | null }> => {
    const result = await fetchBaseDexPriceDetailed(token, chain, timestamp)
    return isSanePrice(result.priceUsd)
      ? { source: 'base_dex', ok: true, reason: null, price: result.priceUsd }
      : { source: 'base_dex', ok: false, reason: result.reason, price: null }
  }
  // Final safety net, DISCLOSED (see file header "COVERAGE PRESERVED"): calls getPriceAtTime
  // directly (rather than the price-only multiProviderPriceSource() wrapper) purely to keep its
  // already-computed `debug.attempts` (dexscreener/coingecko/basedex, each with a real reason)
  // instead of discarding them — same real calls, same real order, same real result either way.

  return async (token, chain, timestamp) => {
    // VERIFIED-STABLECOIN SHORT-CIRCUIT, DISCLOSED (cost-audit finding B.1 — see
    // docs/wallet-provider-cost-audit.md). CONFIRMED WASTE: isVerifiedStablecoinAddress already
    // existed and was already trusted elsewhere in this exact pricing chain — basedex's
    // convertQuoteRatioToUsd prices a verified stablecoin quote leg at $1.00 with no provider call
    // at all — but NOTHING in this router ever consulted it. Every USDC/USDbC/DAI/USDT leg
    // therefore paid the full four-provider fallback chain (GoldRush -> DexScreener ->
    // GeckoTerminal -> CoinGecko/basedex safety net) to discover a price this codebase already
    // treats as deterministic. Since priceLotsForWallet builds a PriceableEntry for EVERY merged
    // inbound/outbound event, and the dominant quote assets on Base/ETH are stablecoins, this was
    // roughly one wasted full fallback chain per trade on a stablecoin-quoted wallet.
    //
    // NOT A NEW EVIDENCE STANDARD, DISCLOSED: $1.00 for a VERIFIED (address-checked, never
    // symbol-guessed — see quoteLegPricing's own stablecoinSymbolFor) USD-pegged stablecoin is the
    // exact same deterministic convention this pipeline already applies in basedex, applied one
    // layer earlier so it costs zero calls instead of four. Address-verified only: an unrecognised
    // "stablecoin-looking" token is untouched and still goes through the full real chain below.
    // Never applied to a non-stablecoin, never used to fill an unrelated gap, and recorded as a
    // prevented duplicate so the cost audit reports exactly what it saved.
    if (isVerifiedStablecoinAddress(chain, token)) {
      recordDuplicatePrevented('goldrush', 'deterministic')
      recordRoute(token, chain, timestamp, 'verified_stablecoin')
      return { price: VERIFIED_STABLECOIN_USD, route: 'verified_stablecoin', attempts: [] }
    }

    const attempts: PriceAttemptDetail[] = []
    let ethNativeDiagnostic: import('../modules/pricingAtTimeEngine/sources/coingecko').NativeEthPricingDiagnostic | null = null

    // Pushes the ETH-native audit entry (if this call ever reached that branch) with whatever
    // fallback attempts were made afterward, then returns the final result — a single exit path so
    // every one of this function's several `return`s below logs consistently, never duplicated.
    function finalize(result: ChainAwareHistoricalPriceResult): ChainAwareHistoricalPriceResult {
      // SUCCESS-EVIDENCE RECORDING, DISCLOSED, ADDITIVE — see
      // src/modules/pricingAtTimeEngine/sourceSuccessEvidence.ts's own header. Every attempt
      // recorded here has ALREADY happened; this adds no call, no retry and no branch of its own. It
      // only preserves the typed {source, ok, reason} outcomes this router already computed, which
      // were otherwise discarded once the price was returned. Purely passive bookkeeping.
      for (const attempt of attempts) {
        recordPricingAttemptOutcome({
          chain,
          token,
          source: attempt.source,
          assetClass: evidenceAssetClassFor(chain, token),
          // This layer genuinely does not know which structural lot side a request belongs to
          // (PriceSourceFn is (token, chain, timestamp) only — see this file's own txHash note
          // above), so the requirement type is recorded honestly as 'unranked' rather than guessed.
          // The estimator's specificity ladder backs off past this level cleanly when it is absent.
          requirementType: 'unranked',
          ok: attempt.ok,
          reason: attempt.reason,
        })
      }
      if (ethNativeDiagnostic) {
        ethNativeRoutingAuditLog.push({
          chain,
          originalContract: token,
          diagnostic: ethNativeDiagnostic,
          fallbackSourcesAttempted: attempts.slice(1),
        })
      }
      return result
    }

    // ETH NATIVE ROUTING, DISCLOSED: see ETH_CANONICAL_WETH_ADDRESS's own declaration above. Only an
    // EXTRA, earlier attempt for this one specific (chain, address) pair — never skips or replaces
    // any of the existing ordering below if it misses, so coverage can only improve, never regress.
    // Preserves the requested timestamp exactly (never "now"); never mutates `token`/`chain` — this
    // reads the SAME token/chain/timestamp the caller already passed in, just tries one more real,
    // more-appropriate source first for this specific well-known address.
    if (chain === 'eth' && token.toLowerCase() === ETH_CANONICAL_WETH_ADDRESS) {
      const nativeResult = await fetchCoingeckoNativeEthPriceDetailed(timestamp)
      ethNativeDiagnostic = nativeResult.diagnostic
      attempts.push({ source: 'coingecko', ok: isSanePrice(nativeResult.priceUsd), reason: nativeResult.reason })
      if (isSanePrice(nativeResult.priceUsd)) {
        recordRoute(token, chain, timestamp, 'coingecko_native_eth')
        return finalize({ price: nativeResult.priceUsd, route: 'coingecko_native_eth', attempts })
      }
    }

    // PRIORITISED BASE DEX, DISCLOSED: see baseDexProvenThisScan's own declaration above. Only ever
    // an EXTRA, earlier attempt at an already-real source — never skips or replaces any of the
    // ordering below if it misses, so coverage can only improve, never regress.
    if (chain === 'base' && baseDexProvenThisScan) {
      const attempt = await tryBaseDex(token, chain, timestamp)
      attempts.push({ source: attempt.source, ok: attempt.ok, reason: attempt.reason })
      if (attempt.price !== null) {
        recordRoute(token, chain, timestamp, 'coingecko_or_basedex')
        return finalize({ price: attempt.price, route: 'coingecko_or_basedex', attempts })
      }
    }

    // SINGLE DEFINITION, DISCLOSED: the per-chain ordering now lives in sourceSuccessEvidence.ts so
    // the success-probability model and this real dispatch order can never drift apart. Same order,
    // same chains, same behaviour as the inline literal it replaces.
    const order = routeSourceOrderFor(chain)

    for (const source of order) {
      const attempt = source === 'goldrush' ? await tryGoldrush(token, chain, timestamp)
        : source === 'dexscreener' ? await tryDexscreener(token, chain, timestamp)
        : await tryGeckoTerminal(token, chain, timestamp)
      attempts.push({ source: attempt.source, ok: attempt.ok, reason: attempt.reason })
      if (attempt.price !== null) {
        recordRoute(token, chain, timestamp, source as PricingRouteUsed)
        return finalize({ price: attempt.price, route: source as PricingRouteUsed, attempts })
      }
    }

    const safetyNetResult = await getPriceAtTime({ chain, tokenAddress: token, timestamp })
    for (const a of safetyNetResult.debug.attempts) {
      attempts.push({ source: a.provider === 'base_dex' ? 'base_dex' : (a.provider as 'dexscreener' | 'coingecko'), ok: a.ok, reason: a.reason })
      if (a.provider === 'base_dex' && a.ok) baseDexProvenThisScan = true
    }
    if (isSanePrice(safetyNetResult.priceUsd)) {
      recordRoute(token, chain, timestamp, 'coingecko_or_basedex')
      return finalize({ price: safetyNetResult.priceUsd, route: 'coingecko_or_basedex', attempts })
    }

    recordRoute(token, chain, timestamp, 'none')
    return finalize({ price: null, route: 'none', attempts })
  }
}

export function buildChainAwareHistoricalPriceSource(goldrush: PriceSourceFn): PriceSourceFn {
  const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)
  return async (token, chain, timestamp) => (await detailed(token, chain, timestamp)).price
}
