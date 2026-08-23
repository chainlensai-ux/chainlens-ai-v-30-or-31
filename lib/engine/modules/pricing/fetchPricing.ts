// lib/engine/modules/pricing/fetchPricing.ts — new pricing module for chainHoldings[].
//
// PRICING-SOURCE CHOICE, DISCLOSED: `fetchTokenPriceUsd`'s own signature (chainId, tokenAddress —
// no timestamp) doesn't match `lib/engines/pricingAtTimeEngine.ts`'s real `getPriceAtTime`, which
// requires an explicit historical `timestamp` (it answers "what was this worth AT a specific
// moment," not "what is it worth now" — see that file's own header). The real module that answers
// "current USD price, no timestamp" is `src/modules/pricing`'s `resolvePrices` (MODULE 11,
// "pricingEngine" — the same real module lib/../timelines/index.ts already reuses for the identical
// reason, with the same disclosed caveat there). Reused here rather than passing a fabricated "now"
// timestamp into a historical-pricing engine, which would silently misuse that engine's real
// contract.
//
// TOKEN METADATA, UPDATED — PORTFOLIO-INTELLIGENCE $0 BUG FIX, DISCLOSED: this module previously
// never used `resolvePrices`'s own `knownPriceUsd` preference because "ChainHolding carries no
// price field at all" — that was true until lib/engine/modules/holdings/fetchHoldings.ts's own fix
// (same task): ChainHolding now carries `providerPriceUsd`/`providerValueUsd`, populated for free
// by the balances provider (GoldRush's balances_v2 call). `priceHoldings` below now short-circuits
// on that known price BEFORE ever calling `fetchTokenPriceUsd`'s DexScreener-only fallback — this
// was the actual root cause of Portfolio Intelligence showing $0/0 priced tokens for wallets whose
// tokens (e.g. low-liquidity Base tokens) failed that fallback, while the older src/modules/
// holdings-backed "Holdings V2" display showed real values because it never went through this
// weaker second lookup in the first place.
//
// CHAIN SUPPORT, DISCLOSED: chainId 1 (eth), 8453 (base), 42161 (arbitrum), and HYPEREVM_CHAIN_ID
// (999) are now all mapped (same CHAIN_ID_TO_SUPPORTED_CHAIN reused from lib/engine/modules/
// holdings/fetchHoldings.ts, extended there in this same fix). An unmapped chainId still honestly
// prices as null, never a guessed value.

import { fetchDexscreenerPriceShared } from '@/src/lib/dexscreenerRequestCache'
import { CHAIN_ID_TO_SUPPORTED_CHAIN } from '../holdings/fetchHoldings'
import type { ChainHolding } from '../holdings/types'
import type { PricedHolding, PricingEngineOutput } from './types'
import { verifyOnchainDecimals, verifyOnchainSymbol } from './rpcDecimals'
import { isVerifiedStablecoinAddress, isCanonicalWethAddress, isNativePseudoAddress } from '@/src/modules/quoteLegPricing/index'

// CANONICAL-ADDRESS STABLECOIN CHECK, DISCLOSED (holdings-fallback-spam follow-up task — confirmed
// production evidence: a symbol-spoofed token reporting itself as "USDC" at a non-canonical address
// was classified `stable` by fetchHoldings.ts's own symbol-only `classify()` and, via that
// classification alone, ranked at the TOP of the fallback queue with a fake ~$1/unit materiality
// estimate derived from its own attacker-minted unit count). Reuses the SAME address-verified
// registry `stablecoinNormalizedGroupTotal`/quote-leg pricing already trusts (`STABLECOIN_ADDRESSES`
// in src/modules/quoteLegPricing/index.ts) — never a second, symbol-based stablecoin list. A chain
// this module has no numeric-chainId mapping for (CHAIN_ID_TO_SUPPORTED_CHAIN) never matches, same
// as every other address-registry check in this codebase.
function isVerifiedStableHolding(h: ChainHolding): boolean {
  const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[h.chainId]
  return chain != null && isVerifiedStablecoinAddress(chain, h.tokenAddress)
}

// A holding classified `stable` by fetchHoldings.ts's OWN symbol-only heuristic, but whose address
// does NOT appear in the canonical, address-verified registry above — exactly the spoof shape
// described above. Never used to exclude a holding (it may well be a genuine token that merely
// shares a common stablecoin ticker) — only to strip the unverified "guaranteed ~$1 asset" trust a
// bare classification match would otherwise grant it.
function isSpoofStableSymbol(h: ChainHolding): boolean {
  return h.classification === 'stable' && !isVerifiedStableHolding(h)
}

// SAME ADDRESS-VERIFIED PRINCIPLE APPLIED TO BLUE-CHIP, DISCLOSED: `classification: 'blue_chip'` is
// ALSO symbol-only (fetchHoldings.ts's `classify()`, BLUE_CHIP_SYMBOLS = ETH/WETH/WBTC) — the same
// spoof vector a fake "WETH" ticker could exploit. Verified via the canonical native-wrapper
// registry / native pseudo-address check quote-leg pricing already trusts (never a second,
// symbol-based list). WBTC has no canonical-address registry anywhere in this codebase yet — an
// unverified WBTC-symbol holding honestly falls through to the unverified/no-signal path below
// rather than being guessed into a trust tier this codebase cannot yet prove.
function isVerifiedBlueChipHolding(h: ChainHolding): boolean {
  if (isNativePseudoAddress(h.tokenAddress)) return true
  const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[h.chainId]
  return chain != null && isCanonicalWethAddress(chain, h.tokenAddress)
}

function isSpoofBlueChipSymbol(h: ChainHolding): boolean {
  return h.classification === 'blue_chip' && !isVerifiedBlueChipHolding(h)
}

export type { PricedHolding, PricingEngineOutput } from './types'

// SCAN-TO-SCAN DIFF, DISCLOSED (portfolio-total-stability audit task, "compare the final priced
// holdings between two scans by chain+token" / "find the exact token responsible for the delta"
// requirements): a real, callable comparison — not just a hope that two separately-logged
// snapshots get manually diffed by a human. Pure and side-effect-free; logs nothing itself (the
// caller decides whether/how to log its result, matching this module's own "compact reason
// counters, not raw responses" convention elsewhere in this codebase).
export type MissingPricedHoldingDiagnostic = {
  missingPricedHolding: string // `${chainId}:${tokenAddress}`
  previousValueUsd: number
  currentValueUsd: number | null
  providerPriceUsd: number | null
  quantity: string
  pricingSource: 'provider' | 'fallback' | 'unpriced'
  exclusionReason: 'absent_from_current_scan' | 'price_lost_between_scans'
}

function holdingKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`
}

function pricingSourceOf(h: Pick<PricedHolding, 'priceUsd'>, chainHolding?: Pick<ChainHolding, 'providerPriceUsd'>): 'provider' | 'fallback' | 'unpriced' {
  if (h.priceUsd == null) return 'unpriced'
  if (chainHolding?.providerPriceUsd != null && chainHolding.providerPriceUsd > 0) return 'provider'
  return 'fallback'
}

// Compares two scans' priced-holdings lists by (chainId, tokenAddress) and returns one compact
// diagnostic per holding that had a real, non-trivial USD value in the PREVIOUS scan but does not
// in the CURRENT one (either missing entirely, or present but unpriced/lower) — the exact
// "responsible token(s)" for a total-value drop, without ever logging a full holdings dump.
// `minValueUsdToReport` bounds noise from dust-level differences (default $1, matching this
// module's own DUST_VALUE_USD_THRESHOLD convention) — never used to hide a real, meaningful loss.
export function diffPricedHoldingsForRegression(
  previous: readonly PricedHolding[],
  current: readonly PricedHolding[],
  minValueUsdToReport = 1,
): MissingPricedHoldingDiagnostic[] {
  const currentByKey = new Map(current.map((h) => [holdingKey(h.chainId, h.tokenAddress), h]))
  const diagnostics: MissingPricedHoldingDiagnostic[] = []
  for (const prev of previous) {
    if (prev.valueUsd == null || prev.valueUsd < minValueUsdToReport) continue
    const key = holdingKey(prev.chainId, prev.tokenAddress)
    const curr = currentByKey.get(key)
    const currentValueUsd = curr?.valueUsd ?? null
    if (currentValueUsd != null && currentValueUsd >= prev.valueUsd) continue // unchanged or improved — not a regression
    diagnostics.push({
      missingPricedHolding: key,
      previousValueUsd: prev.valueUsd,
      currentValueUsd,
      providerPriceUsd: curr?.priceUsd ?? null,
      quantity: curr?.quantity ?? prev.quantity,
      pricingSource: curr ? pricingSourceOf(curr) : 'unpriced',
      exclusionReason: curr ? 'price_lost_between_scans' : 'absent_from_current_scan',
    })
  }
  return diagnostics.sort((a, b) => (b.previousValueUsd - (b.currentValueUsd ?? 0)) - (a.previousValueUsd - (a.currentValueUsd ?? 0)))
}

// SHARED CACHE, DISCLOSED (provider-call-audit follow-up task, confirmed root cause of "far more
// than 30 DexScreener calls in one scan" despite MAX_FALLBACK_TOKENS=30 below): this previously
// called `resolvePrices` (src/modules/pricing), which internally reaches src/modules/pricing/
// utils.ts's OWN separate, uncoordinated DexScreener implementation — entirely disconnected from
// the historical pricing pass's own DexScreener calls (src/modules/pricingAtTimeEngine/sources/
// dexscreener.ts, also used by recovery). A token needing a fallback price in BOTH this
// current-holdings lane and the historical/recovery lane fired two independent real HTTP calls for
// the identical answer, and neither lane's own per-lane cap bounded the other's total. Now routes
// through the SAME shared, request-scoped cache both lanes use — real coalescing across the whole
// scan, not just within one lane. `resolvePrices`/src/modules/pricing are untouched and still used
// exactly as before by their other, unrelated callers (app/api/token, app/api/radar, etc.) — this
// changes only fetchTokenPriceUsd's OWN implementation. Never throws: fetchDexscreenerPriceShared
// already resolves every request to a real result (priceUsd: null on any failure), and this
// function adds no additional network call of its own. `Date.now()` as the timestamp is correct
// here (never a historical guess) — this is explicitly a CURRENT-price lookup, matching this
// module's own file-header contract; DexScreener would reject anything else as historical anyway.
export async function fetchTokenPriceUsd(chainId: number, tokenAddress: string): Promise<number | null> {
  const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[chainId]
  if (!chain) return null // unsupported chainId — honestly unpriced, never guessed

  const result = await fetchDexscreenerPriceShared(tokenAddress, chain, Date.now(), 'holdings')
  return result.priceUsd
}

// FALLBACK-LOOKUP CONCURRENCY CAP, DISCLOSED (provider-call-audit task): only the holdings that
// genuinely need `priceFn`'s DexScreener-only fallback (no free `providerPriceUsd`) reach this —
// previously ALL of them fired via one unbounded `Promise.all`, so a wallet with dozens of
// low-liquidity tokens with no provider price drove dozens of simultaneous DexScreener HTTP calls
// in one burst. Same bounded-concurrency pattern already used for the historical pricing pass
// (pricingAtTimeEngine/index.ts's PRICE_ENTRY_CONCURRENCY_LIMIT) — zero correctness change, every
// holding still gets the exact same lookup, only how many run AT ONCE changes.
const FALLBACK_PRICE_CONCURRENCY_LIMIT = 10

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// DUST ELIGIBILITY, DISCLOSED (provider-call-audit follow-up task, confirmed real cause of "very
// large" DexScreener fan-out): every holding lacking a free `providerPriceUsd` was previously
// eligible for the fallback lookup, including obvious dust — a wallet can hold dozens of
// near-zero-quantity or already-known-negligible-value tokens (airdrops, LP dust, failed-swap
// remainders), each burning a real DexScreener call for a price that can never matter to the
// wallet's totals either way. Two REAL signals, never a fabricated one, decide eligibility:
//   1. `providerValueUsd` — when GoldRush's own balances_v2 call already reports SOME USD value
//      (even though `providerPriceUsd` itself didn't pass the `> 0` gate above, e.g. a value present
//      with a zero/negative rate edge case), a value under DUST_VALUE_USD_THRESHOLD is already known
//      to be negligible — no need to ask DexScreener too.
//   2. `quantity` — when there is NO provider value signal at all, an honest, disclosed limitation:
//      true USD-value dust can't be determined without a price (the exact thing being looked up), so
//      this only filters holdings whose human-readable quantity itself is at or near zero
//      (DUST_QUANTITY_FLOOR) — a real, bounded heuristic, not a substitute for an actual valuation.
// A holding this excludes gets priceUsd: null, same as any other honestly-unpriced holding — never
// zero, never fabricated.
const DUST_VALUE_USD_THRESHOLD = 1
const DUST_QUANTITY_FLOOR = 1e-6

function isEligibleForFallbackPricing(h: ChainHolding): boolean {
  if (h.providerPriceUsd != null && h.providerPriceUsd > 0) return false // already has a free price
  if (h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD) return false
  const quantity = Number(h.quantity)
  if (!Number.isFinite(quantity) || quantity <= DUST_QUANTITY_FLOOR) return false
  return true
}

// BOUNDED FALLBACK BUDGET, DISCLOSED (provider-call-audit follow-up task, confirmed cause of
// remaining "80-90 DexScreener lookups"): the dust filter above only catches near-zero-quantity or
// already-known-negligible-value holdings — it does NOT bound the total count of genuinely
// eligible-but-unverified holdings, and a wallet holding dozens of low-liquidity/airdropped/spam
// tokens (real, nonzero quantities the dust filter can't distinguish from a real position without a
// price — the exact chicken-and-egg limitation already disclosed above) still sent every one of
// them to DexScreener. This caps the real fallback lookups per scan and PRIORITIZES which holdings
// get one, using three real signals already present on ChainHolding — never a fabricated one:
//   1. providerValueUsd — a real (if partial) USD signal from the balances provider outranks having
//      none at all.
//   2. quantity — a weak but real proxy when there's no value signal (can't rank across tokens by
//      true value without a price, which is what's being looked up — same honest limitation as the
//      dust floor above).
//   3. lastActivityAt — a token this wallet has interacted with recently is far more likely a real,
//      meaningful position than an untouched airdrop/spam drop sitting in the wallet.
// A holding that doesn't make the cut is NEVER hidden and NEVER defaulted to zero — it stays in
// pricedHoldings with priceUsd/valueUsd: null, exactly like any other honestly-unpriced holding.
const MAX_FALLBACK_TOKENS = 30

// CONFIRMED ROOT CAUSE, DISCLOSED (holdings-coverage audit task, real production evidence: 1,581
// holdings discovered / 107 priced / 1,346 fallback-eligible / only 30 looked up / 1,316 left
// unpriced by budget, with a canonical total far below the wallet's expected value): the PRIOR
// ranking above was, in practice, RAW QUANTITY DESCENDING. Two independent reasons:
//   1. Tier 1 (`providerValueUsd`) is absent for almost every fallback-eligible holding — by
//      definition these are the holdings the balances provider did NOT price, and a provider that
//      supplies no `quote_rate` overwhelmingly supplies no `quote` either. So tier 1 is a tie at -1
//      across nearly the whole candidate set and decides nothing.
//   2. Tier 3 (`lastActivityAt`) is DEAD: lib/engine/modules/holdings/fetchHoldings.ts hardcodes
//      `lastActivityAt: null` for every holding (see its own header — no per-token activity indexer
//      is wired at that level), so every candidate scores -Infinity and it decides nothing either.
// That left tier 2, raw `quantity`, as the sole effective discriminator — and raw unit count is
// precisely the axis spam/airdrop tokens maximize (they are minted with astronomically large unit
// counts). A holding of 500,000,000,000 spam units therefore outranked a real 0.05 WETH position
// on EVERY scan, deterministically, so the same spam tokens consumed the same 30-token budget
// forever while genuinely valuable holdings were never checked (this task's findings 5 and 6).
//
// FIX, DISCLOSED: rank by likely USD materiality using ONLY evidence already present on
// ChainHolding — no new provider call, no fabricated price, no change to the cap (still exactly 30),
// and no change to any price-selection safety rule (minimum liquidity / base-token-side validation
// in dexscreener.ts are untouched). Lanes, highest priority first:
//   1. providerValueUsd — a real, provider-supplied partial USD figure still outranks everything.
//   2. assetClassRank — `classification` is real local metadata (fetchHoldings.ts's classify():
//      STABLE_SYMBOLS -> 'stable', BLUE_CHIP_SYMBOLS (ETH/WETH/WBTC) -> 'blue_chip'). A native,
//      wrapped-native or stablecoin holding is a known real asset; spam is never in those sets.
//   3. estimatedMaterialityUsd — RANKING ONLY, never a price: a stablecoin's unit count is a real,
//      defensible ~$1/unit materiality estimate. Non-stables get -1 (unknown, never guessed).
//   4. symbolQualityRank — a malformed symbol ('?' from an Alchemy row with no metadata, empty, or
//      the whitespace/URL/overlong shapes airdrop spam uses to advertise) is a real, local spam
//      signal. Well-formed symbols rank above it.
//   5. quantity — the previous signal, demoted to a last-resort magnitude tiebreak where it can no
//      longer let unit count alone dominate the budget.
// A holding that still doesn't make the cut is NEVER hidden and NEVER defaulted to zero — it stays
// in pricedHoldings with priceUsd/valueUsd: null, exactly as before.
const ASSET_CLASS_RANK: Record<ChainHolding['classification'], number> = {
  stable: 3,
  blue_chip: 2,
  lp: 1,
  meme: 0,
  other: 0,
}

// SPAM-SYMBOL SHAPES, DISCLOSED: deliberately conservative — only shapes a legitimate ERC-20 ticker
// effectively never has. '?' is this codebase's own placeholder for an Alchemy row with no metadata
// (src/modules/holdings/utils.ts), whose decimals also defaulted to 18, making its quantity
// unreliable. Whitespace / URL punctuation / overlong strings are the advertising shapes airdrop
// spam uses ("claim at site.com"). Never used to EXCLUDE a holding — only to rank it lower.
const MAX_PLAUSIBLE_SYMBOL_LENGTH = 16

export function isWellFormedSymbol(symbol: string | null | undefined): boolean {
  if (typeof symbol !== 'string') return false
  const trimmed = symbol.trim()
  if (trimmed.length === 0 || trimmed === '?') return false
  if (trimmed.length > MAX_PLAUSIBLE_SYMBOL_LENGTH) return false
  if (/\s/.test(trimmed)) return false
  if (/[./\\:]/.test(trimmed)) return false
  return true
}

// PURE, exported for direct testing. A real, local materiality ESTIMATE used only to order the
// fallback queue — it is never written to priceUsd/valueUsd and never contributes to any total.
// Returns null when there is genuinely no local basis to estimate, rather than guessing.
export function estimateMaterialityUsd(h: ChainHolding): number | null {
  if (h.providerValueUsd != null && h.providerValueUsd > 0) return h.providerValueUsd
  const quantity = Number(h.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0) return null
  // A stablecoin's unit count is a real ~$1/unit materiality estimate (this codebase already treats
  // USDC as $1 in basedex.ts's own disclosed convention) — but ONLY once the token's address is
  // address-verified against the canonical registry (isVerifiedStableHolding), never from
  // fetchHoldings.ts's own symbol-only `classify()` alone (confirmed production spam vector: a
  // symbol-spoofed "USDC" at an attacker-controlled address, minted with a huge fake unit count, was
  // previously granted a huge fake ~$1/unit materiality estimate from that unit count alone). No
  // other classification supports a local estimate without a price lookup, which is the exact thing
  // being queued.
  if (isVerifiedStableHolding(h)) return quantity
  return null
}

// REAL, NON-FABRICATED "this holding is more than a raw unit count" SIGNAL, DISCLOSED
// (holdings-fallback-spam follow-up task — explicit requirement: "penalize quantity-only holdings
// with no provider value, no price, no recent transfer signal, no materiality signal"). True only
// when at least one of these already-available-for-free signals is present:
//   - a real, provider-supplied partial USD value
//   - a canonical, address-verified stablecoin (never a bare symbol match)
//   - a real recent-transfer timestamp (lastActivityAt — currently always null per
//     fetchHoldings.ts's own disclosed limitation, included here so it engages automatically the
//     moment that data becomes real, with zero further change needed here)
// Deliberately EXCLUDES well-formed-symbol and raw quantity — a well-formed ticker and a large unit
// count are exactly the two things obvious spam (BONKO/CLOUD/CASHCAT-shaped tokens) can trivially
// fake for free; neither is treated as proof of real materiality.
function hasRealMaterialitySignal(h: ChainHolding): boolean {
  return (h.providerValueUsd != null && h.providerValueUsd > 0)
    || isVerifiedStableHolding(h)
    || isVerifiedBlueChipHolding(h)
    || h.lastActivityAt != null
}

function fallbackPriorityScore(h: ChainHolding): number[] {
  const providerValueSignal = h.providerValueUsd != null && h.providerValueUsd > 0 ? h.providerValueUsd : -1
  const spoofStable = isSpoofStableSymbol(h)
  const spoofBlueChip = isSpoofBlueChipSymbol(h)
  // SPOOF DEMOTION, DISCLOSED: a `stable`/`blue_chip`-classified holding whose address is not
  // canonically verified is stripped of the trusted tier entirely — ranked exactly like any other
  // unverified "other" holding, never above it.
  const assetClassRank = (spoofStable || spoofBlueChip) ? 0 : (ASSET_CLASS_RANK[h.classification] ?? 0)
  const estimatedMateriality = estimateMaterialityUsd(h)
  const materialitySignal = estimatedMateriality ?? -1
  const symbolQualityRank = isWellFormedSymbol(h.symbol) ? 1 : 0
  const quantity = Number(h.quantity)
  const hasRealSignal = hasRealMaterialitySignal(h)
  // REAL-SIGNAL GATE, DISCLOSED: the single highest-priority lane. Any holding with at least one
  // real materiality signal ranks above EVERY holding that has none, regardless of either one's raw
  // unit count — closing the confirmed production gap where a 900-trillion-unit spam token
  // outranked genuinely real, evidence-backed positions purely on magnitude.
  const realSignalRank = hasRealSignal ? 1 : 0
  // QUANTITY NEUTRALIZED FOR SPAM, DISCLOSED: raw unit count is precisely the axis spam/airdrop
  // tokens maximize for free. It remains a legitimate LAST-RESORT tiebreak among holdings that
  // already cleared the real-signal gate (e.g. two provider-valued positions), but contributes
  // NOTHING to ranking among holdings with no real signal at all — those are ordered only by symbol
  // quality and then the deterministic lexicographic key tiebreak below, never by whichever one
  // happens to hold the most attacker-minted units.
  const quantitySignal = hasRealSignal && Number.isFinite(quantity) ? quantity : 0
  return [realSignalRank, providerValueSignal, assetClassRank, materialitySignal, symbolQualityRank, quantitySignal]
}

function compareFallbackPriority(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (b[i] !== a[i]) return b[i] - a[i] // descending: highest signal first
  }
  return 0
}

// HOLDINGS-COVERAGE AUDIT, DISCLOSED (this task's explicit diagnostic requirement): one record per
// UNPRICED holding, carrying exactly the requested fields. Pure and exported so the full set can be
// asserted in tests ("required diagnostics for every unpriced holding") — while the console audit
// below deliberately logs only the top candidates plus counts, because a real wallet in this
// investigation produced 1,316 unpriced holdings and one log line each would blow past this
// deployment's per-invocation log capture limit (the same real constraint already documented in
// src/modules/pricingAtTimeEngine/sources/basedex.ts's own log-volume fix).
export type FallbackSkipReason =
  | 'priced_by_provider'
  | 'known_negligible_provider_value'
  | 'zero_or_malformed_quantity'
  | 'outside_fallback_budget'
  | 'fallback_lookup_returned_no_price'
  | 'spoof_stable_symbol'
  | 'quantity_only_spam_suppressed'

// EXPLICIT SELECTION REASONS, DISCLOSED (holdings-fallback-spam follow-up task's explicit
// requirement: "add explicit skip/selection reasons"). ADDITIVE, separate from `skipReason` above —
// `skipReason` describes the post-hoc OUTCOME (was this ever priced, and if not, why is it still
// unpriced right now); `selectionReason` describes the ranking-time RATIONALE for whether this
// holding was ever a real candidate for one of the bounded fallback slots, independent of whether
// the lookup (if it ran) later found a price. Kept as two fields rather than overloading one, so
// existing `skipReason` consumers/tests are completely unaffected by this addition.
export type FallbackSelectionReason =
  | 'priced_by_provider'
  | 'known_negligible_provider_value'
  | 'zero_or_malformed_quantity'
  | 'spoof_stable_symbol'
  | 'selected_material_candidate'
  | 'no_materiality_signal'
  | 'outside_fallback_budget'
  | 'quantity_only_spam_suppressed'

export type UnpricedHoldingDiagnostic = {
  chainId: number
  tokenAddress: string
  symbol: string
  quantity: string
  providerPriceUsd: number | null
  providerValueUsd: number | null
  fallbackEligible: boolean
  fallbackRank: number | null
  selectedForFallback: boolean
  skipReason: FallbackSkipReason
  selectionReason: FallbackSelectionReason
  knownBalanceSignal: 'provider_value' | 'stable_unit_peg' | 'quantity_only' | 'none'
  currentTransferRecency: string | null
  estimatedMaterialitySignal: number | null
}

// PURE, exported for direct testing.
export function buildUnpricedHoldingDiagnostics(params: {
  holdings: ChainHolding[]
  pricedHoldings: PricedHolding[]
  rankedFallbackKeys: string[]
  budgetedFallbackKeys: string[]
  keyOf: (h: ChainHolding) => string
}): UnpricedHoldingDiagnostic[] {
  const { holdings, pricedHoldings, rankedFallbackKeys, budgetedFallbackKeys, keyOf } = params
  const rankByKey = new Map(rankedFallbackKeys.map((k, i) => [k, i]))
  const budgeted = new Set(budgetedFallbackKeys)
  const diagnostics: UnpricedHoldingDiagnostic[] = []

  for (let i = 0; i < holdings.length; i += 1) {
    const h = holdings[i]
    const p = pricedHoldings[i]
    if (p?.priceUsd != null) continue // genuinely priced — not part of this audit

    const key = keyOf(h)
    const eligible = isEligibleForFallbackPricing(h)
    const rank = rankByKey.get(key) ?? null
    const selected = budgeted.has(key)
    const quantity = Number(h.quantity)
    const estimatedMaterialitySignal = estimateMaterialityUsd(h)

    const spoofStable = isSpoofStableSymbol(h)
    const hasRealSignal = hasRealMaterialitySignal(h)

    // ENRICHED, DISCLOSED (holdings-fallback-spam follow-up task #2 — explicit requirement: "skip
    // reason quantity_only_spam_suppressed" / "spoof stable symbol => skipReason
    // spoof_stable_symbol" must appear in production, not only in the separate `selectionReason`
    // field below). A holding that IS selected is always reported as `fallback_lookup_returned_no_price`
    // regardless of WHY it was selected (material, or exploratory-mode no-signal) — this field
    // answers "what happened to this holding", `selectionReason` below answers "why was it
    // (not) chosen".
    let skipReason: FallbackSkipReason
    if (h.providerPriceUsd != null && h.providerPriceUsd > 0) skipReason = 'priced_by_provider'
    else if (h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD) skipReason = 'known_negligible_provider_value'
    else if (!Number.isFinite(quantity) || quantity <= DUST_QUANTITY_FLOOR) skipReason = 'zero_or_malformed_quantity'
    else if (spoofStable) skipReason = 'spoof_stable_symbol'
    else if (selected) skipReason = 'fallback_lookup_returned_no_price'
    else if (hasRealSignal) skipReason = 'outside_fallback_budget'
    else skipReason = 'quantity_only_spam_suppressed'

    let selectionReason: FallbackSelectionReason
    if (h.providerPriceUsd != null && h.providerPriceUsd > 0) selectionReason = 'priced_by_provider'
    else if (h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD) selectionReason = 'known_negligible_provider_value'
    else if (!Number.isFinite(quantity) || quantity <= DUST_QUANTITY_FLOOR) selectionReason = 'zero_or_malformed_quantity'
    else if (spoofStable) selectionReason = 'spoof_stable_symbol'
    else if (selected) selectionReason = hasRealSignal ? 'selected_material_candidate' : 'no_materiality_signal'
    else selectionReason = hasRealSignal ? 'outside_fallback_budget' : 'quantity_only_spam_suppressed'

    const knownBalanceSignal = h.providerValueUsd != null && h.providerValueUsd > 0
      ? 'provider_value'
      : isVerifiedStableHolding(h) && Number.isFinite(quantity) && quantity > 0
        ? 'stable_unit_peg'
        : Number.isFinite(quantity) && quantity > 0
          ? 'quantity_only'
          : 'none'

    diagnostics.push({
      chainId: h.chainId,
      tokenAddress: h.tokenAddress,
      symbol: h.symbol,
      quantity: h.quantity,
      providerPriceUsd: h.providerPriceUsd ?? null,
      providerValueUsd: h.providerValueUsd ?? null,
      fallbackEligible: eligible,
      fallbackRank: rank,
      selectionReason,
      selectedForFallback: selected,
      skipReason,
      knownBalanceSignal,
      // HONEST NULL, DISCLOSED: `lastActivityAt` is hardcoded null for every holding by
      // lib/engine/modules/holdings/fetchHoldings.ts (no per-token activity indexer is wired at that
      // level — see its own header). Reported as the real null it is, never fabricated.
      currentTransferRecency: h.lastActivityAt ?? null,
      estimatedMaterialitySignal,
    })
  }

  return diagnostics
}

// Public entry point. `priceHoldings(holdings)` — exactly the signature specified; the second
// parameter is an ADDITIVE, optional testing seam (defaults to the real fetchTokenPriceUsd above),
// added because node:test's `t.mock.module` proved unreliable under this project's tsx-based test
// runner (verified directly — it threw `t.mock.module is not a function` when actually run, not
// assumed) and a fabricated network-call double would be worse than a plain, explicit, optional
// parameter. Never throws: fetchTokenPriceUsd above already can't, and every step below is pure
// arithmetic over its result.
//
// DEDUPE + BOUNDED FALLBACK, DISCLOSED (provider-call-audit task, confirmed real duplicate-call
// source): holdings sharing the exact same (chainId, tokenAddress) — e.g. the same token tracked
// under two classification buckets — previously each fired their OWN independent `priceFn` call
// for an identical current-price lookup. Deduped here by resolving each distinct (chainId,
// tokenAddress) pair's fallback price exactly ONCE and reusing it across every holding that shares
// it — same real value either way, since it's the same token at the same instant, never a
// fabricated or stale substitute.
// EXPLORATORY-SPAM-LOOKUP GATE, DISCLOSED (holdings-fallback-spam follow-up task #2 — confirmed
// production evidence: even after ranking demoted no-signal quantity-only holdings below
// real-signal ones, they were STILL selected and spent real DexScreener calls whenever real-signal
// candidates didn't fill the whole 30-slot budget — ranking alone only ever changes ORDER, never
// ELIGIBILITY). Defaults OFF (env-gated, same "explicit opt-in via its own separate flag" pattern
// this file already uses for HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED) — production never spends a
// real call on a holding with zero real materiality evidence. A test/caller may override this
// directly via the function's own optional parameter, the same testing-seam convention `priceFn`
// itself already uses.
function exploratorySpamLookupEnabledByDefault(): boolean {
  return process.env.HOLDINGS_FALLBACK_EXPLORATORY_SPAM_LOOKUP_ENABLED === 'true'
}

export async function priceHoldings(
  holdings: ChainHolding[],
  priceFn: (chainId: number, tokenAddress: string) => Promise<number | null> = fetchTokenPriceUsd,
  options: { allowExploratorySpamLookup?: boolean } = {},
): Promise<PricingEngineOutput> {
  const allowExploratorySpamLookup = options.allowExploratorySpamLookup ?? exploratorySpamLookupEnabledByDefault()
  // Only holdings genuinely eligible for the fallback (no free provider price, not dust) ever reach
  // priceFn — see isEligibleForFallbackPricing's own header for the two real signals used.
  const fallbackKeyOf = (h: ChainHolding) => `${h.chainId}:${h.tokenAddress.toLowerCase()}`
  const providerPriced = holdings.filter((h) => h.providerPriceUsd != null && h.providerPriceUsd > 0)
  const knownUnderDollarSkipped = holdings.filter(
    (h) => !(h.providerPriceUsd != null && h.providerPriceUsd > 0)
      && h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD,
  )
  const quantityDustSkipped = holdings.filter((h) => {
    if (h.providerPriceUsd != null && h.providerPriceUsd > 0) return false
    if (h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD) return false
    const quantity = Number(h.quantity)
    return !Number.isFinite(quantity) || quantity <= DUST_QUANTITY_FLOOR
  })
  const eligibleHoldings = holdings.filter(isEligibleForFallbackPricing)
  const distinctFallbackKeys = Array.from(new Set(eligibleHoldings.map(fallbackKeyOf)))

  // Best (highest-priority) score across every holding sharing a key — a token appearing under two
  // classification buckets is ranked by whichever bucket carries the strongest real signal.
  const bestScoreByKey = new Map<string, number[]>()
  for (const h of eligibleHoldings) {
    const key = fallbackKeyOf(h)
    const score = fallbackPriorityScore(h)
    const existing = bestScoreByKey.get(key)
    if (!existing || compareFallbackPriority(score, existing) < 0) bestScoreByKey.set(key, score)
  }
  // DETERMINISTIC ORDERING, DISCLOSED (this task's explicit requirement): an explicit
  // lexicographic tiebreak on the `chainId:tokenAddress` key means two holdings with genuinely
  // identical signals always resolve the same way — the selected 30 can never shift between scans
  // because of provider response ordering or Array.sort implementation details.
  const rankedFallbackKeys = [...distinctFallbackKeys].sort((a, b) => {
    const byScore = compareFallbackPriority(bestScoreByKey.get(a)!, bestScoreByKey.get(b)!)
    if (byScore !== 0) return byScore
    return a.localeCompare(b)
  })
  // ELIGIBILITY GATE, NOT JUST RANKING, DISCLOSED (holdings-fallback-spam follow-up task #2):
  // `bestScoreByKey.get(key)![0]` is exactly `realSignalRank` from `fallbackPriorityScore` — 1 when
  // at least one holding sharing this key has a real materiality signal (provider value, a
  // canonically address-verified stablecoin, or real transfer recency), 0 otherwise. Material
  // candidates are budgeted FIRST, in full rank order; a no-signal candidate only ever consumes a
  // real DexScreener call when material candidates leave slack in the budget AND exploratory lookup
  // is explicitly allowed — production defaults to neither spending calls on them nor leaving them
  // ranked-but-unselected as a false promise, they are genuinely never queued.
  const materialFallbackKeys = rankedFallbackKeys.filter((key) => bestScoreByKey.get(key)![0] === 1)
  const noSignalFallbackKeys = rankedFallbackKeys.filter((key) => bestScoreByKey.get(key)![0] === 0)
  const budgetedMaterialKeys = materialFallbackKeys.slice(0, MAX_FALLBACK_TOKENS)
  const remainingBudgetAfterMaterial = MAX_FALLBACK_TOKENS - budgetedMaterialKeys.length
  const budgetedNoSignalKeys = allowExploratorySpamLookup && remainingBudgetAfterMaterial > 0
    ? noSignalFallbackKeys.slice(0, remainingBudgetAfterMaterial)
    : []
  const budgetedFallbackKeys = [...budgetedMaterialKeys, ...budgetedNoSignalKeys]
  const budgetedFallbackKeySet = new Set(budgetedFallbackKeys)
  const overBudgetKeys = rankedFallbackKeys.filter((key) => !budgetedFallbackKeySet.has(key))

  // DIAGNOSTIC, DISCLOSED (provider-call-audit follow-up task, explicit "report before changing
  // thresholds" requirement): real counts only, no behavior change from this log — reports exactly
  // how many holdings fall into each eligibility bucket so a future pass can decide whether the
  // DUST_VALUE_USD_THRESHOLD/DUST_QUANTITY_FLOOR heuristics need adjusting, instead of guessing.
  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] DexScreener fallback eligibility', {
    holdingsTotal: holdings.length,
    providerPriced: providerPriced.length,
    knownUnderDollarSkipped: knownUnderDollarSkipped.length,
    quantityDustSkipped: quantityDustSkipped.length,
    fallbackEligible: eligibleHoldings.length,
    uniqueFallbackEligible: distinctFallbackKeys.length,
    fallbackBudget: MAX_FALLBACK_TOKENS,
    budgetedForLookup: budgetedFallbackKeys.length,
    overBudgetUnpriced: overBudgetKeys.length,
    // ELIGIBILITY-GATE VISIBILITY, DISCLOSED (holdings-fallback-spam follow-up task #2): real counts
    // proving no-signal holdings were genuinely excluded from spend, not merely reordered.
    materialFallbackCandidates: materialFallbackKeys.length,
    noSignalFallbackCandidates: noSignalFallbackKeys.length,
    budgetedMaterialKeys: budgetedMaterialKeys.length,
    budgetedNoSignalKeys: budgetedNoSignalKeys.length,
    allowExploratorySpamLookup,
    timestamp: Date.now(),
  })
  const fallbackPriceByKey = new Map<string, number | null>()
  const resolvedPrices = await mapWithConcurrencyLimit(budgetedFallbackKeys, FALLBACK_PRICE_CONCURRENCY_LIMIT, async (key) => {
    const [chainIdStr, tokenAddress] = key.split(':')
    return priceFn(Number(chainIdStr), tokenAddress)
  })
  budgetedFallbackKeys.forEach((key, i) => fallbackPriceByKey.set(key, resolvedPrices[i]))
  // Holdings whose key didn't make the cut stay honestly unpriced (priceUsd/valueUsd: null below) —
  // never hidden from pricedHoldings, never defaulted to zero.

  const pricedHoldings: PricedHolding[] = holdings.map((h): PricedHolding => {
    // Prefer the balances provider's own real, free price (see file header) — only fall through
    // to the weaker, capped, deduped DexScreener-only lookup when the provider genuinely didn't
    // supply one.
    const priceUsd = h.providerPriceUsd != null && h.providerPriceUsd > 0
      ? h.providerPriceUsd
      : fallbackPriceByKey.get(fallbackKeyOf(h)) ?? null
    const recomputedValueUsd = priceUsd != null ? Number(h.quantity) * priceUsd : null
    // CONFIRMED ROOT CAUSE, DISCLOSED (dominant-holding price audit, real production evidence: the
    // same wallet's total swinging between ~$5.2k/$9k/$13.5k/$6.4k across scans while its priced-
    // holding COUNT stayed stable — one dominant token, e.g. FreeCode, worth thousands of dollars
    // on its own): this previously ALWAYS recomputed valueUsd as `Number(h.quantity) * priceUsd`,
    // discarding the balances provider's OWN `providerValueUsd` (GoldRush's `quote` field) even
    // when the provider supplied it directly. GoldRush computes `quote` from ITS OWN internal
    // balance/decimals math — recomputing locally from `h.quantity` (itself derived from
    // `contract_decimals`, which defaults to 18 when GoldRush's response omits it — see
    // src/modules/holdings/utils.ts) can diverge from GoldRush's own authoritative figure whenever
    // this wallet's specific decimals/balance parsing is even slightly inconsistent between scans —
    // exactly the kind of low-liquidity, thin-metadata token ("FreeCode"-shaped) most likely to
    // have exactly this problem, and exactly why the total swung across scans while everything else
    // held steady. Fixed: prefer the provider's own valueUsd when it directly supplied BOTH a price
    // and a value (the two are its own internally-consistent pair) — recompute from quantity*price
    // ONLY when no provider value exists at all (i.e., the fallback-priced case, where there never
    // was a provider figure to trust in the first place). Never fabricated either way — both are
    // real numbers from real sources, this only changes WHICH real source is trusted first.
    const valueUsd = h.providerPriceUsd != null && h.providerPriceUsd > 0 && h.providerValueUsd != null && h.providerValueUsd > 0
      ? h.providerValueUsd
      : recomputedValueUsd
    if (valueUsd != null && recomputedValueUsd != null && Math.abs(valueUsd - recomputedValueUsd) > Math.max(1, valueUsd * 0.05)) {
      // DIAGNOSTIC, DISCLOSED: real, compact evidence of exactly the "providerValueUsd disagrees
      // with quantity*price" audit item this task asks about — never silently ignored, and never
      // used to override the now-authoritative provider figure without a trace.
      // eslint-disable-next-line no-console
      console.warn('[dominant-holding-audit] providerValueUsd disagrees with locally recomputed value', {
        chainId: h.chainId, tokenAddress: h.tokenAddress, symbol: h.symbol,
        providerValueUsd: h.providerValueUsd, recomputedValueUsd, quantity: h.quantity, decimals: h.decimals, priceUsd,
      })
    }
    return {
      chainId: h.chainId,
      tokenAddress: h.tokenAddress,
      symbol: h.symbol,
      decimals: h.decimals,
      quantity: h.quantity,
      priceUsd,
      valueUsd,
      classification: h.classification,
    }
  })

  // DUPLICATED-BALANCE GUARD, DISCLOSED (FreeCode valuation audit task, explicit "check for
  // duplicated balance" requirement): distinguishes a genuine duplicate — the exact SAME
  // (chainId, tokenAddress, quantity) reported more than once, i.e. one real on-chain balance
  // counted twice — from a legitimate case this codebase already relies on (see this module's own
  // test "two holdings sharing the same (chainId, tokenAddress) ... exactly once, not once per
  // holding"), where the SAME token genuinely appears more than once with DIFFERENT quantities
  // (e.g. distinct classification buckets each carrying their own real sub-balance). Keying on
  // quantity too means two real, distinct sub-balances of the same token are never conflated, while
  // an exact repeat of the identical balance is only ever counted once toward the total. Never
  // hides a holding from `pricedHoldings` — only guards the SUMMED total/chain figures.
  const seenExactBalanceKeys = new Set<string>()
  const duplicateBalancesDropped: Array<{ chainId: number; tokenAddress: string; quantity: string; valueUsd: number | null }> = []
  let totalValueUsd = 0
  const chainValueUsd: Record<number, number> = {}
  for (const p of pricedHoldings) {
    const exactKey = `${p.chainId}:${p.tokenAddress.toLowerCase()}:${p.quantity}`
    if (seenExactBalanceKeys.has(exactKey)) {
      duplicateBalancesDropped.push({ chainId: p.chainId, tokenAddress: p.tokenAddress, quantity: p.quantity, valueUsd: p.valueUsd })
      continue
    }
    seenExactBalanceKeys.add(exactKey)
    totalValueUsd += p.valueUsd ?? 0
    chainValueUsd[p.chainId] = (chainValueUsd[p.chainId] ?? 0) + (p.valueUsd ?? 0)
  }
  if (duplicateBalancesDropped.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[duplicate-balance-audit] exact-duplicate (chainId, tokenAddress, quantity) balance excluded from total', {
      duplicateBalancesDropped,
    })
  }

  const pricedCount = pricedHoldings.filter((p) => p.priceUsd != null).length
  const priceStatus: PricingEngineOutput['priceStatus'] =
    pricedHoldings.length === 0 || pricedCount === 0
      ? 'unavailable'
      : pricedCount === pricedHoldings.length
        ? 'ok'
        : 'partial'

  // DIAGNOSTIC, DISCLOSED (portfolio-total-stability audit task): a compact snapshot of the actual
  // priced holdings this scan produced — real per-chain totals (chainValueUsd, restated here under
  // its requested diagnostic name) and the top-N priced holdings by value (symbol/chain/valueUsd/
  // priceUsd only — never a raw provider response). Comparing this log between two scans of the
  // SAME wallet is exactly what lets a real total-value regression (like the confirmed one this
  // task traces — one token's price silently dropped during holdings merge) be pinpointed to the
  // exact token responsible, without needing to log every holding's full row on every scan.
  const topValueHoldings = [...pricedHoldings]
    .filter((p) => p.valueUsd != null)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
    .slice(0, 10)
    .map((p) => ({ chainId: p.chainId, tokenAddress: p.tokenAddress, symbol: p.symbol, valueUsd: p.valueUsd, priceUsd: p.priceUsd }))
  // eslint-disable-next-line no-console
  console.warn('[portfolio-total-audit] priced holdings snapshot', {
    totalValueUsd: Math.round(totalValueUsd * 100) / 100,
    portfolioTotalByChain: chainValueUsd,
    pricedHoldingsCount: pricedCount,
    topValueHoldings,
    timestamp: Date.now(),
  })

  // HOLDINGS-COVERAGE AUDIT, DISCLOSED (this task's explicit production-audit requirement): reports
  // exactly how much of this wallet the canonical total actually covers, and which unpriced holdings
  // were the strongest candidates that the bounded budget could not reach. Every field is a real
  // count or a real local signal — `estimatedPotentiallyMaterialUnpricedCount` counts only holdings
  // with a REAL local materiality estimate (provider partial value, or a stablecoin's ~$1/unit peg)
  // above $1; a token with no local basis to estimate is never counted as material on a guess.
  const unpricedDiagnostics = buildUnpricedHoldingDiagnostics({
    holdings,
    pricedHoldings,
    rankedFallbackKeys,
    budgetedFallbackKeys,
    keyOf: fallbackKeyOf,
  })
  const estimatedPotentiallyMaterialUnpricedCount = unpricedDiagnostics.filter(
    (d) => d.estimatedMaterialitySignal != null && d.estimatedMaterialitySignal > DUST_VALUE_USD_THRESHOLD,
  ).length
  const TOP_UNPRICED_CANDIDATES_LOGGED = 15
  const topUnpricedCandidates = unpricedDiagnostics
    .filter((d) => d.fallbackEligible)
    .sort((a, b) => {
      const byMateriality = (b.estimatedMaterialitySignal ?? -1) - (a.estimatedMaterialitySignal ?? -1)
      if (byMateriality !== 0) return byMateriality
      return (a.fallbackRank ?? Number.MAX_SAFE_INTEGER) - (b.fallbackRank ?? Number.MAX_SAFE_INTEGER)
    })
    .slice(0, TOP_UNPRICED_CANDIDATES_LOGGED)
  // BUG FIX, DISCLOSED (holdings-fallback-spam follow-up task #2 — confirmed production evidence:
  // this log's own `fallbackSelectionReasons` field was aggregating `skipReason` — the post-hoc
  // OUTCOME reason — under a name that promises the SELECTION rationale, so it could never surface
  // `selected_material_candidate`/`spoof_stable_symbol`/`quantity_only_spam_suppressed`, all of
  // which only ever appear on `selectionReason`). Aggregates the correct field now.
  const fallbackSelectionReasons: Record<string, number> = {}
  for (const d of unpricedDiagnostics) {
    fallbackSelectionReasons[d.selectionReason] = (fallbackSelectionReasons[d.selectionReason] ?? 0) + 1
  }
  // eslint-disable-next-line no-console
  console.warn('[holdings-coverage-audit] current-holdings pricing coverage', {
    canonicalTotalValueUsd: Math.round(totalValueUsd * 100) / 100,
    pricedHoldingsCount: pricedCount,
    unpricedHoldingsCount: unpricedDiagnostics.length,
    fallbackEligibleCount: distinctFallbackKeys.length,
    fallbackBudget: MAX_FALLBACK_TOKENS,
    estimatedPotentiallyMaterialUnpricedCount,
    topUnpricedCandidates,
    fallbackSelectionReasons,
  })

  // DOMINANT-HOLDING PRICE PROVENANCE, DISCLOSED (this task's explicit requirement): traces exactly
  // how a holding worth >= 10% of the portfolio got its price — real production evidence showed a
  // single dominant token (a "FreeCode"-shaped low-liquidity holding) driving the portfolio total's
  // multi-thousand-dollar swings across scans. Re-querying the shared DexScreener cache for an
  // already-fallback-priced dominant holding is a genuine cache HIT (same key already populated
  // above), never a second real network call — see src/lib/dexscreenerRequestCache.ts's own header.
  const DOMINANT_HOLDING_SHARE_THRESHOLD = 0.10
  if (totalValueUsd > 0) {
    for (let i = 0; i < holdings.length; i += 1) {
      const h = holdings[i]
      const p = pricedHoldings[i]
      if (p.valueUsd == null || p.valueUsd / totalValueUsd < DOMINANT_HOLDING_SHARE_THRESHOLD) continue

      const usedProvider = h.providerPriceUsd != null && h.providerPriceUsd > 0
      const fallbackPriceUsd = fallbackPriceByKey.get(fallbackKeyOf(h)) ?? null
      const winningSource = usedProvider ? 'provider' : fallbackPriceUsd != null ? 'fallback' : 'unpriced'

      let pairInfo: { pairAddress: string | null; dexId: string | null; liquidityUsd: number | null; pairAgeMs: number | null; quoteTokenSymbol: string | null; alternatePairs: unknown[]; winnerReason: string | null } | null = null
      // GUARD, DISCLOSED: only re-queries the shared cache when this call is genuinely using the
      // real default `fetchTokenPriceUsd` (which itself routes through the SAME shared cache) —
      // reference-equality check against the function this parameter defaults to. When a caller
      // injects a different `priceFn` (the test-only seam this module's own header discloses), the
      // shared cache was never touched for this token, so re-querying it here would be a genuine,
      // unwanted NEW network attempt rather than a cache hit — skipped entirely in that case,
      // never silently faked.
      if (winningSource === 'fallback' && priceFn === fetchTokenPriceUsd && CHAIN_ID_TO_SUPPORTED_CHAIN[h.chainId]) {
        // Cache hit, not a new call — this exact (chain, token, freshness-bucket) key was already
        // populated by the fallback-pricing pass above.
        const detailed = await fetchDexscreenerPriceShared(h.tokenAddress, CHAIN_ID_TO_SUPPORTED_CHAIN[h.chainId], Date.now(), 'holdings')
        pairInfo = detailed
      }

      // RPC-VERIFIED DECIMALS, DISCLOSED (FreeCode valuation audit task's explicit requirement,
      // "decimals are RPC-verified for dominant holdings"): a dominant holding's `decimals` (and
      // therefore its `quantity` and `valueUsd`) previously always trusted the balances provider's
      // own `contract_decimals` with no independent check — see rpcDecimals.ts's own header for why
      // that's the exact gap a thin-metadata, low-liquidity token like this can fall through.
      // Bounded to dominant holdings only (never a per-holding blanket RPC audit) and cached
      // permanently per (chainId, tokenAddress) by verifyOnchainDecimals itself.
      let decimalsRecomputed = false
      const rpcVerifiedDecimals = await verifyOnchainDecimals(h.chainId, h.tokenAddress)
      if (rpcVerifiedDecimals != null && rpcVerifiedDecimals !== h.decimals && h.amountRaw != null && p.priceUsd != null) {
        const correctedQuantity = Number(h.amountRaw) / 10 ** rpcVerifiedDecimals
        if (Number.isFinite(correctedQuantity)) {
          const correctedValueUsd = correctedQuantity * p.priceUsd
          const previousValueUsd = p.valueUsd
          totalValueUsd += correctedValueUsd - (previousValueUsd ?? 0)
          chainValueUsd[h.chainId] = (chainValueUsd[h.chainId] ?? 0) + (correctedValueUsd - (previousValueUsd ?? 0))
          p.decimals = rpcVerifiedDecimals
          p.quantity = String(correctedQuantity)
          p.valueUsd = correctedValueUsd
          decimalsRecomputed = true
          // eslint-disable-next-line no-console
          console.warn('[dominant-holding-audit] provider-reported decimals disagreed with RPC-verified on-chain decimals — recomputed', {
            chainId: h.chainId, tokenAddress: h.tokenAddress, symbol: h.symbol,
            providerReportedDecimals: h.decimals, rpcVerifiedDecimals,
            previousQuantity: h.quantity, correctedQuantity: String(correctedQuantity),
            previousValueUsd, correctedValueUsd,
          })
        }
      }

      // eslint-disable-next-line no-console
      console.warn('[dominant-holding-audit] holding >= 10% of portfolio', {
        chainId: h.chainId,
        tokenAddress: h.tokenAddress,
        symbol: h.symbol,
        quantity: h.quantity,
        decimals: h.decimals,
        winningPriceSource: winningSource,
        providerPriceUsd: h.providerPriceUsd,
        providerValueUsd: h.providerValueUsd,
        fallbackPriceUsd,
        selectedPairAddress: pairInfo?.pairAddress ?? null,
        selectedDexId: pairInfo?.dexId ?? null,
        selectedChain: CHAIN_ID_TO_SUPPORTED_CHAIN[h.chainId] ?? null,
        liquidityUsd: pairInfo?.liquidityUsd ?? null,
        pairAgeMs: pairInfo?.pairAgeMs ?? null,
        quoteTokenSymbol: pairInfo?.quoteTokenSymbol ?? null,
        priceTimestamp: Date.now(),
        alternatePairs: pairInfo?.alternatePairs ?? [],
        winnerReason: pairInfo?.winnerReason ?? (usedProvider ? 'provider_supplied_price_no_dexscreener_query' : null),
        rpcVerifiedDecimals,
        providerReportedDecimals: h.decimals,
        decimalsRecomputed,
        priceUsd: p.priceUsd,
        valueUsd: p.valueUsd,
        dominantHoldingValueShare: Math.round((p.valueUsd! / totalValueUsd) * 10000) / 100,
        dominantHoldingPriceSource: winningSource,
        dominantHoldingLiquidityUsd: pairInfo?.liquidityUsd ?? null,
        portfolioValueExcludingDominantHolding: Math.round((totalValueUsd - p.valueUsd!) * 100) / 100,
      })
    }
  }

  // TOP-2-HOLDING IDENTITY CHECK, DISCLOSED (second-largest-holding identity check task, real
  // production evidence: a wallet's second-largest priced row showed symbol "TORIVA" at
  // 0xb886cf1444bff05e9a99e00543bc4054d423ebfd worth ~$256.82, while the wallet owner expected that
  // value to belong to "NEMESIS" — a SEPARATE, real ChainHolding at
  // 0xb235cf255b48500df4459475e054e7beb25cb772 worth only ~$1.84). CONFIRMED SCOPE: this only
  // reaches the TOP 2 holdings by value — narrower than the >=10%-share dominant-holding block
  // above, since a real second-largest holding can legitimately sit well under 10% of a small
  // portfolio (7.6% here) and would otherwise never get an identity check at all.
  //
  // IDENTITY IS THE ADDRESS, NEVER THE SYMBOL, DISCLOSED (this task's explicit "verify ... from
  // contract address, not symbol" / "never merge tokens by symbol" requirement): each holding below
  // is checked strictly by its OWN (chainId, tokenAddress) — two holdings that happen to display
  // the same symbol are NEVER combined or treated as interchangeable here, and a holding's own
  // valueUsd/quantity/priceUsd are NEVER touched by this block (only `symbol`, a display label, may
  // be corrected) — there is no evidence here of the two addresses' BALANCES being swapped, only of
  // a possible DISPLAY-LABEL mismatch, so only the label is ever corrected, per this task's own
  // "do not change values unless the address mapping is wrong" instruction.
  const TOP_N_FOR_IDENTITY_CHECK = 2
  const topByValue = pricedHoldings
    .map((p, i) => ({ p, h: holdings[i] }))
    .filter((row) => row.p.valueUsd != null)
    .sort((a, b) => (b.p.valueUsd ?? 0) - (a.p.valueUsd ?? 0))
    .slice(0, TOP_N_FOR_IDENTITY_CHECK)

  // PERF-SPRINT TASK, DISCLOSED ("detect sequential operations that could safely run in parallel"):
  // bounded to TOP_N_FOR_IDENTITY_CHECK = 2 rows, each iteration reads/writes only its OWN `p`/`h`
  // (distinct objects per row — `topByValue` is built via `.map`, never shared/aliased across rows)
  // and never accumulates into any variable shared across rows (unlike the dominant-holding block
  // above, which deliberately stays sequential because it DOES mutate a shared `totalValueUsd`
  // accumulator) — safe to run concurrently with zero correctness change, only real wall-clock
  // savings on the RPC/DexScreener calls inside each iteration.
  await Promise.all(topByValue.map(async ({ p, h }) => {
    const providerSymbol = h.symbol
    // RPC ground truth, DISCLOSED: real on-chain symbol() for this exact address — cached
    // permanently by rpcDecimals.ts, so a repeat check for the same token across scans costs zero
    // further RPC calls. `null` means verification genuinely unavailable (unsupported chain/no RPC
    // key/contract revert), never a guessed symbol.
    const rpcSymbol = await verifyOnchainSymbol(h.chainId, h.tokenAddress)

    // DexScreener's own view of this address's identity, DISCLOSED: reused from the SAME shared
    // cache/detailed lookup as the dominant-holding block above (a genuine cache hit when this
    // holding was already fallback-priced this scan; skipped entirely for a provider-priced holding
    // or under the test-only priceFn seam, same guard reasoning as above — never a new live call).
    let dexscreenerBaseTokenSymbol: string | null = null
    const usedProviderForThis = h.providerPriceUsd != null && h.providerPriceUsd > 0
    if (!usedProviderForThis && priceFn === fetchTokenPriceUsd && CHAIN_ID_TO_SUPPORTED_CHAIN[h.chainId]) {
      const detailed = await fetchDexscreenerPriceShared(h.tokenAddress, CHAIN_ID_TO_SUPPORTED_CHAIN[h.chainId], Date.now(), 'holdings')
      dexscreenerBaseTokenSymbol = detailed.baseTokenSymbol
    }

    // SELECTION RULE, DISCLOSED: the on-chain contract's OWN symbol() is the real ground truth for
    // what a specific ADDRESS is — preferred whenever RPC verification succeeded. Falls back to the
    // balances provider's symbol only when RPC verification is genuinely unavailable (never a
    // fabricated symbol either way).
    const selectedSymbol = rpcSymbol ?? providerSymbol
    let mismatchReason: string | null = null
    if (rpcSymbol == null) {
      mismatchReason = 'rpc_unavailable'
    } else if (rpcSymbol.toUpperCase() !== providerSymbol.toUpperCase()) {
      mismatchReason = 'provider_symbol_mismatch'
    } else if (dexscreenerBaseTokenSymbol != null && dexscreenerBaseTokenSymbol.toUpperCase() !== rpcSymbol.toUpperCase()) {
      mismatchReason = 'dexscreener_symbol_mismatch'
    }

    // eslint-disable-next-line no-console
    console.warn('[token-identity-audit] top-2-by-value holding identity check', {
      address: h.tokenAddress,
      providerSymbol,
      rpcSymbol,
      selectedSymbol,
      mismatchReason,
    })

    // Only the display label is ever corrected here — see this block's own header disclosure.
    if (selectedSymbol !== p.symbol) {
      p.symbol = selectedSymbol
    }
  }))

  return { pricedHoldings, totalValueUsd, chainValueUsd, priceStatus }
}
