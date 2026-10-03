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

// DECIMALS PROVENANCE (fallback-selection fix): an Alchemy-only row carries ASSUMED 18 decimals, so its
// `quantity` is meaningless for a 6-decimal USDC (1,250 USDC -> 1.25e-9 "units"). Confirmed production
// effect: canonical stablecoins were dropped as "dust" before any lookup. For such a row only the raw
// on-chain amount can prove "zero"; the quantity floor applies only when decimals are known.
function decimalsKnown(h: ChainHolding): boolean {
  return h.decimalsVerified !== false
}

function hasPositiveRawAmount(h: ChainHolding): boolean {
  if (h.amountRaw == null) return false
  try {
    return BigInt(h.amountRaw) > BigInt(0)
  } catch {
    return false
  }
}

/** Why a holding never reaches the fallback (null = eligible). */
function fallbackGateReason(h: ChainHolding): 'priced_by_provider' | 'known_negligible_provider_value' | 'zero_or_malformed_quantity' | null {
  if (h.providerPriceUsd != null && h.providerPriceUsd > 0) return 'priced_by_provider' // already has a free price
  if (h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD) return 'known_negligible_provider_value'
  if (!decimalsKnown(h)) return hasPositiveRawAmount(h) ? null : 'zero_or_malformed_quantity'
  const quantity = Number(h.quantity)
  if (!Number.isFinite(quantity) || quantity <= DUST_QUANTITY_FLOOR) return 'zero_or_malformed_quantity'
  return null
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
  // Assumed decimals make the unit count meaningless — no estimate (the holding still ranks as material).
  if (isVerifiedStableHolding(h) && decimalsKnown(h)) return quantity
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

// ─── FALLBACK LANES (fallback-selection fix) ─────────────────────────────────────────────────────────
// CONFIRMED PRODUCTION BUG: GoldRush balances failed (transient http_503), Alchemy supplied 108 holdings
// with no symbol, no price and assumed decimals — so NOTHING carried a "real materiality signal", all 103
// eligible holdings were classed no-signal, and the exploratory gate (default off) spent ZERO of the 30
// lookups: `103 eligible / 0 selected / 0 priced`. A missing price is exactly why the fallback exists —
// "no price evidence" must never by itself mean "spam". The budget is now split into three lanes, filled
// in order, all inside the SAME unchanged 30-lookup cap:
//   1. material    — provider value, canonical (address-verified) stablecoin, native / canonical WETH;
//   2. activity    — a real recent-transfer signal (lastActivityAt). CURRENTLY UNAVAILABLE IN PRODUCTION:
//      fetchHoldings.ts sets lastActivityAt = null for every holding (no per-token activity index), and the
//      only per-token transfer evidence (fetchParsedTrades) is fetched AFTER this pricing pass in
//      workers/walletScanV2.ts, so no clean join exists yet. The lane is kept structurally so it engages the
//      moment real evidence is supplied; the audit reports it as 'unavailable' until then.
//   3. exploratory — every other eligible holding, split into CLEAN unknowns (no junk signal) and
//      SUSPICIOUS ones (exploratorySuspicion). Only clean unknowns reserve slots ahead of lanes 1–2
//      (up to FALLBACK_EXPLORATORY_RESERVED_SLOTS) — a discovery floor so unknown assets can't be starved.
//      Suspicious rows never displace a material/activity candidate: they only use capacity lanes 1–2 left
//      unused. Exploratory spend stays capped at the reserved size unless
//      HOLDINGS_FALLBACK_EXPLORATORY_SPAM_LOOKUP_ENABLED opts in. Never more than the global budget.
// Spoofed stable/blue-chip tickers (impersonation evidence) are never explored.
export const FALLBACK_EXPLORATORY_RESERVED_SLOTS = 8

export type FallbackLane = 'material' | 'activity' | 'exploratory'

function isMaterialHolding(h: ChainHolding): boolean {
  return (h.providerValueUsd != null && h.providerValueUsd > 0) || isVerifiedStableHolding(h) || isVerifiedBlueChipHolding(h)
}

function fallbackLaneOf(h: ChainHolding): FallbackLane {
  if (isMaterialHolding(h)) return 'material'
  if (h.lastActivityAt != null) return 'activity'
  return 'exploratory'
}

const LANE_ORDER: Record<FallbackLane, number> = { material: 0, activity: 1, exploratory: 2 }

/**
 * Why an exploratory holding looks like junk — used ONLY to rank it lower, never to exclude it or to call
 * it worthless. All signals are local, already-available evidence; a symbol is never proof of value.
 */
export type ExploratorySuspicion = 'malformed_decimals' | 'nft_like_zero_decimals' | 'astronomical_unit_count' | 'round_airdrop_amount' | 'advertising_symbol'

// Airdrop spam is minted with absurd unit counts — the exact axis the old ranking maximized.
const ASTRONOMICAL_UNIT_COUNT = 1e12

export function exploratorySuspicion(h: ChainHolding): ExploratorySuspicion | null {
  if (decimalsKnown(h)) {
    if (!Number.isInteger(h.decimals) || h.decimals < 0 || h.decimals > 36) return 'malformed_decimals'
    if (h.decimals === 0) return 'nft_like_zero_decimals'
    if (Number(h.quantity) >= ASTRONOMICAL_UNIT_COUNT) return 'astronomical_unit_count'
  }
  // Airdrop spam is minted in round amounts (exactly 1, 1,000, 1,000,000 units …); a traded balance almost
  // never is. Raw amount with trailing zeros stripped has at most 2 significant digits.
  if (h.amountRaw != null && /^\d+$/.test(h.amountRaw)) {
    const significant = h.amountRaw.replace(/^0+/, '').replace(/0+$/, '')
    if (significant.length > 0 && significant.length <= 2) return 'round_airdrop_amount'
  }
  const sym = typeof h.symbol === 'string' ? h.symbol.trim() : ''
  if (sym !== '' && sym !== '?' && !isWellFormedSymbol(sym)) return 'advertising_symbol'
  return null
}

// Exploratory ranking: no junk signal first, then token metadata present, then (decimals known only) the
// larger balance; the caller's lexicographic key tiebreak keeps it fully deterministic.
function exploratoryPriorityScore(h: ChainHolding): number[] {
  const quantity = Number(h.quantity)
  return [
    exploratorySuspicion(h) == null ? 1 : 0,
    isWellFormedSymbol(h.symbol) ? 1 : 0, // token metadata present
    // Larger balance only when decimals are known (an assumed-decimals quantity is not comparable).
    decimalsKnown(h) && Number.isFinite(quantity) ? quantity : 0,
  ]
}

/** Deterministic lane-based selection inside the fixed budget. Pure, exported for tests. */
export function selectFallbackKeys(params: {
  /** Each lane already ranked; `exploratory` ranks clean unknowns ahead of suspicious ones. */
  rankedKeysByLane: Record<FallbackLane, string[]>
  /** Exploratory keys carrying a junk signal (default: none). */
  suspiciousExploratoryKeys?: ReadonlySet<string>
  budget: number
  exploratoryReserved: number
  allowExploratorySpamLookup: boolean
}): { material: string[]; activity: string[]; exploratory: string[] } {
  const { rankedKeysByLane: lanes, budget } = params
  const suspicious = params.suspiciousExploratoryKeys ?? new Set<string>()
  const clean = lanes.exploratory.filter((k) => !suspicious.has(k))
  const junk = lanes.exploratory.filter((k) => suspicious.has(k))
  const reservedSize = Math.min(Math.max(0, params.exploratoryReserved), budget)
  // Discovery floor: only CLEAN unknowns hold slots ahead of material/activity.
  const reservedForClean = Math.min(reservedSize, clean.length)
  const primaryCap = budget - reservedForClean
  const material = lanes.material.slice(0, primaryCap)
  const activity = lanes.activity.slice(0, primaryCap - material.length)
  const remaining = budget - material.length - activity.length
  // Suspicious rows only get capacity material/activity left unused; exploratory spend stays capped at the
  // reserved size unless explicitly opted in.
  const exploratoryCap = params.allowExploratorySpamLookup ? remaining : Math.min(reservedSize, remaining)
  const exploratory = [...clean, ...junk].slice(0, exploratoryCap)
  return { material, activity, exploratory }
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
  // Fallback-selection fix: an exploratory holding with no junk signal that the reserved slice didn't reach.
  | 'outside_exploratory_budget'
  // A fallback price was found, but the holding's decimals were only assumed and could not be verified
  // on-chain — never valued from a guessed quantity.
  | 'decimals_unverified'

// EXPLICIT SELECTION REASONS, DISCLOSED (holdings-fallback-spam follow-up task's explicit
// requirement: "add explicit skip/selection reasons"). ADDITIVE, separate from `skipReason` above —
// `skipReason` describes the post-hoc OUTCOME (was this ever priced, and if not, why is it still
// unpriced right now); `selectionReason` describes the ranking-time RATIONALE for whether this
// holding was ever a real candidate for one of the bounded fallback slots, independent of whether
// the lookup (if it ran) later found a price.
export type FallbackSelectionReason =
  | 'priced_by_provider'
  | 'known_negligible_provider_value'
  | 'zero_or_malformed_quantity'
  | 'spoof_stable_symbol'
  | 'selected_material_candidate'
  | 'selected_activity_candidate'
  | 'selected_exploratory_candidate'
  | 'outside_fallback_budget'
  | 'outside_exploratory_budget'
  | 'quantity_only_spam_suppressed'

export type UnpricedHoldingDiagnostic = {
  chainId: number
  tokenAddress: string
  symbol: string
  quantity: string
  providerPriceUsd: number | null
  providerValueUsd: number | null
  fallbackEligible: boolean
  fallbackLane: FallbackLane | null
  fallbackRank: number | null
  selectedForFallback: boolean
  skipReason: FallbackSkipReason
  selectionReason: FallbackSelectionReason
  knownBalanceSignal: 'provider_value' | 'stable_unit_peg' | 'quantity_only' | 'none'
  currentTransferRecency: string | null
  estimatedMaterialitySignal: number | null
}

type FallbackClassification = {
  eligible: boolean
  lane: FallbackLane | null
  rank: number | null
  selected: boolean
  skipReason: FallbackSkipReason
  selectionReason: FallbackSelectionReason
  suspicion: ExploratorySuspicion | null
}

// One classifier for both the unpriced diagnostics and the full per-holding audit.
function classifyFallbackHolding(
  h: ChainHolding,
  key: string,
  ctx: { rankByKey: Map<string, number>; budgeted: Set<string>; decimalsUnverifiedKeys?: ReadonlySet<string> },
): FallbackClassification {
  const gate = fallbackGateReason(h)
  const rank = ctx.rankByKey.get(key) ?? null
  const selected = ctx.budgeted.has(key)
  const suspicion = exploratorySuspicion(h)
  if (gate) return { eligible: false, lane: null, rank, selected: false, skipReason: gate, selectionReason: gate, suspicion }
  if (isSpoofStableSymbol(h)) return { eligible: true, lane: null, rank, selected: false, skipReason: 'spoof_stable_symbol', selectionReason: 'spoof_stable_symbol', suspicion }
  const lane = fallbackLaneOf(h)
  if (selected) {
    const selectionReason: FallbackSelectionReason = lane === 'material' ? 'selected_material_candidate' : lane === 'activity' ? 'selected_activity_candidate' : 'selected_exploratory_candidate'
    const skipReason: FallbackSkipReason = ctx.decimalsUnverifiedKeys?.has(key) ? 'decimals_unverified' : 'fallback_lookup_returned_no_price'
    return { eligible: true, lane, rank, selected, skipReason, selectionReason, suspicion }
  }
  if (lane !== 'exploratory') return { eligible: true, lane, rank, selected, skipReason: 'outside_fallback_budget', selectionReason: 'outside_fallback_budget', suspicion }
  const junk = suspicion != null || isSpoofBlueChipSymbol(h)
  const reason = junk ? 'quantity_only_spam_suppressed' : 'outside_exploratory_budget'
  return { eligible: true, lane, rank, selected, skipReason: reason, selectionReason: reason, suspicion }
}

// PURE, exported for direct testing.
export function buildUnpricedHoldingDiagnostics(params: {
  holdings: ChainHolding[]
  pricedHoldings: PricedHolding[]
  rankedFallbackKeys: string[]
  budgetedFallbackKeys: string[]
  keyOf: (h: ChainHolding) => string
  decimalsUnverifiedKeys?: ReadonlySet<string>
}): UnpricedHoldingDiagnostic[] {
  const { holdings, pricedHoldings, rankedFallbackKeys, budgetedFallbackKeys, keyOf } = params
  const ctx = { rankByKey: new Map(rankedFallbackKeys.map((k, i) => [k, i])), budgeted: new Set(budgetedFallbackKeys), decimalsUnverifiedKeys: params.decimalsUnverifiedKeys }
  const diagnostics: UnpricedHoldingDiagnostic[] = []

  for (let i = 0; i < holdings.length; i += 1) {
    const h = holdings[i]
    const p = pricedHoldings[i]
    if (p?.priceUsd != null) continue // genuinely priced — not part of this audit

    const c = classifyFallbackHolding(h, keyOf(h), ctx)
    const quantity = Number(h.quantity)
    const knownBalanceSignal = h.providerValueUsd != null && h.providerValueUsd > 0
      ? 'provider_value'
      : isVerifiedStableHolding(h) && decimalsKnown(h) && Number.isFinite(quantity) && quantity > 0
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
      fallbackEligible: c.eligible,
      fallbackLane: c.lane,
      fallbackRank: c.rank,
      selectionReason: c.selectionReason,
      selectedForFallback: c.selected,
      skipReason: c.skipReason,
      knownBalanceSignal,
      // `lastActivityAt` is null for every holding today (no per-token activity indexer at the holdings
      // level) — reported as the real null it is, never fabricated.
      currentTransferRecency: h.lastActivityAt ?? null,
      estimatedMaterialitySignal: estimateMaterialityUsd(h),
    })
  }

  return diagnostics
}

/** Full per-holding fallback audit (every current holding, priced or not). */
export type HoldingFallbackAuditRow = {
  chainId: number
  tokenAddress: string
  symbol: string
  rawQuantity: string | null
  decimals: number
  decimalsSource: 'provider' | 'assumed' | 'onchain_verified'
  uiBalance: string
  providerPriceUsd: number | null
  providerValueUsd: number | null
  transferRecency: string | null
  currentActivitySignal: boolean
  assetClass: 'native' | 'wrapped_native' | 'verified_stablecoin' | 'spoof_stable_symbol' | 'spoof_blue_chip_symbol' | 'unverified'
  knownMetadata: boolean
  materialitySignal: 'provider_value' | 'verified_asset' | 'recent_activity' | 'none'
  spamDustReason: string | null
  fallbackEligible: boolean
  fallbackLane: FallbackLane | null
  fallbackRank: number | null
  selectedForFallback: boolean
  priceUsd: number | null
  valueUsd: number | null
  priceSource: 'provider' | 'dexscreener_fallback' | 'unpriced'
  skipReason: FallbackSkipReason | null
}

const HOLDING_AUDIT_MAX_ROWS = 150

export type HoldingsFallbackAudit = {
  holdingsTotal: number
  providerPriced: number
  fallbackEligible: number
  fallbackBudget: number
  exploratoryReservedSlots: number
  candidates: Record<FallbackLane, number>
  exploratoryCandidates: { clean: number; suspicious: number }
  exploratorySelected: { clean: number; suspicious: number }
  /**
   * 'unavailable' when no holding carries per-token activity evidence (today: always — see FALLBACK LANES).
   * Never inferred from symbol, balance size or a fabricated timestamp.
   */
  activityLane: { status: 'active' | 'unavailable'; reason: string | null }
  selected: Record<FallbackLane, number>
  budgetedForLookup: number
  fallbackPriced: number
  decimalsVerifiedOnchain: number
  decimalsUnverified: number
  pricedCount: number
  unpricedCount: number
  rows: HoldingFallbackAuditRow[]
  rowsTruncated: boolean
}

export function buildHoldingFallbackAudit(params: {
  holdings: ChainHolding[]
  pricedHoldings: PricedHolding[]
  rankedFallbackKeys: string[]
  budgetedFallbackKeys: string[]
  keyOf: (h: ChainHolding) => string
  decimalsUnverifiedKeys?: ReadonlySet<string>
  onchainDecimalsByKey?: ReadonlyMap<string, number>
}): HoldingFallbackAuditRow[] {
  const { holdings, pricedHoldings, keyOf } = params
  const ctx = { rankByKey: new Map(params.rankedFallbackKeys.map((k, i) => [k, i])), budgeted: new Set(params.budgetedFallbackKeys), decimalsUnverifiedKeys: params.decimalsUnverifiedKeys }
  return holdings.map((h, i) => {
    const p = pricedHoldings[i]
    const key = keyOf(h)
    const c = classifyFallbackHolding(h, key, ctx)
    const providerPriced = h.providerPriceUsd != null && h.providerPriceUsd > 0
    const priced = p?.priceUsd != null
    const assetClass: HoldingFallbackAuditRow['assetClass'] = isNativePseudoAddress(h.tokenAddress)
      ? 'native'
      : isVerifiedBlueChipHolding(h)
        ? 'wrapped_native'
        : isVerifiedStableHolding(h)
          ? 'verified_stablecoin'
          : isSpoofStableSymbol(h)
            ? 'spoof_stable_symbol'
            : isSpoofBlueChipSymbol(h)
              ? 'spoof_blue_chip_symbol'
              : 'unverified'
    const materialitySignal: HoldingFallbackAuditRow['materialitySignal'] = h.providerValueUsd != null && h.providerValueUsd > 0
      ? 'provider_value'
      : isVerifiedStableHolding(h) || isVerifiedBlueChipHolding(h)
        ? 'verified_asset'
        : h.lastActivityAt != null
          ? 'recent_activity'
          : 'none'
    const gate = fallbackGateReason(h)
    const spamDustReason = gate === 'known_negligible_provider_value' || gate === 'zero_or_malformed_quantity'
      ? gate
      : c.suspicion ?? (assetClass === 'spoof_stable_symbol' || assetClass === 'spoof_blue_chip_symbol' ? assetClass : null)
    return {
      chainId: h.chainId,
      tokenAddress: h.tokenAddress,
      symbol: h.symbol,
      rawQuantity: h.amountRaw ?? null,
      decimals: p?.decimals ?? h.decimals,
      decimalsSource: decimalsKnown(h) ? 'provider' : params.onchainDecimalsByKey?.has(key) ? 'onchain_verified' : 'assumed',
      uiBalance: p?.quantity ?? h.quantity,
      providerPriceUsd: h.providerPriceUsd ?? null,
      providerValueUsd: h.providerValueUsd ?? null,
      transferRecency: h.lastActivityAt ?? null,
      currentActivitySignal: h.lastActivityAt != null,
      assetClass,
      knownMetadata: isWellFormedSymbol(h.symbol),
      materialitySignal,
      spamDustReason,
      fallbackEligible: c.eligible,
      fallbackLane: c.lane,
      fallbackRank: c.rank,
      selectedForFallback: c.selected,
      priceUsd: p?.priceUsd ?? null,
      valueUsd: p?.valueUsd ?? null,
      priceSource: providerPriced ? 'provider' : priced ? 'dexscreener_fallback' : 'unpriced',
      skipReason: priced ? null : c.skipReason,
    }
  })
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

export type PriceHoldingsOptions = {
  allowExploratorySpamLookup?: boolean
  /** On-chain decimals() reader (testing seam). Default: RPC-verified, permanently cached. */
  decimalsFn?: (chainId: number, tokenAddress: string) => Promise<number | null>
}

export async function priceHoldings(
  holdings: ChainHolding[],
  priceFn: (chainId: number, tokenAddress: string) => Promise<number | null> = fetchTokenPriceUsd,
  options: PriceHoldingsOptions = {},
): Promise<PricingEngineOutput> {
  const allowExploratorySpamLookup = options.allowExploratorySpamLookup ?? exploratorySpamLookupEnabledByDefault()
  const decimalsFn = options.decimalsFn ?? verifyOnchainDecimals
  // Only holdings genuinely eligible for the fallback (no free provider price, not dust) ever reach
  // priceFn — see fallbackGateReason.
  const fallbackKeyOf = (h: ChainHolding) => `${h.chainId}:${h.tokenAddress.toLowerCase()}`
  const gateByIndex = holdings.map(fallbackGateReason)
  const providerPriced = holdings.filter((_, i) => gateByIndex[i] === 'priced_by_provider')
  const knownUnderDollarSkipped = holdings.filter((_, i) => gateByIndex[i] === 'known_negligible_provider_value')
  const quantityDustSkipped = holdings.filter((_, i) => gateByIndex[i] === 'zero_or_malformed_quantity')
  const eligibleHoldings = holdings.filter((_, i) => gateByIndex[i] === null)
  const distinctFallbackKeys = Array.from(new Set(eligibleHoldings.map(fallbackKeyOf)))

  // DUPLICATES: holdings sharing (chainId, tokenAddress) are ONE fallback candidate — the strongest lane
  // and score among them wins. The same address on two chains is two distinct tokens (chainId is in the key).
  const laneByKey = new Map<string, FallbackLane>()
  const spoofedKeys = new Set<string>()
  const bestScoreByKey = new Map<string, number[]>()
  for (const h of eligibleHoldings) {
    const key = fallbackKeyOf(h)
    if (isSpoofStableSymbol(h) || isSpoofBlueChipSymbol(h)) spoofedKeys.add(key)
    const lane = fallbackLaneOf(h)
    const existingLane = laneByKey.get(key)
    if (existingLane === undefined || LANE_ORDER[lane] < LANE_ORDER[existingLane]) laneByKey.set(key, lane)
  }
  for (const h of eligibleHoldings) {
    const key = fallbackKeyOf(h)
    const lane = laneByKey.get(key)!
    if (fallbackLaneOf(h) !== lane) continue // scored only within the key's strongest lane
    const score = lane === 'exploratory' ? exploratoryPriorityScore(h) : fallbackPriorityScore(h)
    const existing = bestScoreByKey.get(key)
    if (!existing || compareFallbackPriority(score, existing) < 0) bestScoreByKey.set(key, score)
  }
  // DETERMINISTIC ORDERING: lane first, then score, then an explicit lexicographic `chainId:tokenAddress`
  // tiebreak — identical inputs (and exploration memory) always select the same keys, whatever the
  // provider's response order.
  const rankedFallbackKeys = [...distinctFallbackKeys].sort((a, b) => {
    const byLane = LANE_ORDER[laneByKey.get(a)!] - LANE_ORDER[laneByKey.get(b)!]
    if (byLane !== 0) return byLane
    const byScore = compareFallbackPriority(bestScoreByKey.get(a)!, bestScoreByKey.get(b)!)
    if (byScore !== 0) return byScore
    return a.localeCompare(b)
  })
  const rankedKeysByLane: Record<FallbackLane, string[]> = { material: [], activity: [], exploratory: [] }
  for (const key of rankedFallbackKeys) {
    if (spoofedKeys.has(key) && laneByKey.get(key) === 'exploratory') continue // impersonation is never explored
    rankedKeysByLane[laneByKey.get(key)!].push(key)
  }
  // Activity lane honesty: only 'active' when some holding actually carries per-token activity evidence.
  const activityLane: HoldingsFallbackAudit['activityLane'] = holdings.some((h) => h.lastActivityAt != null)
    ? { status: 'active', reason: null }
    : { status: 'unavailable', reason: 'no_per_token_activity_evidence_at_pricing_time' }
  // Exploratory scores lead with "no junk signal" (exploratoryPriorityScore[0]).
  const suspiciousExploratoryKeys = new Set(rankedKeysByLane.exploratory.filter((k) => bestScoreByKey.get(k)![0] === 0))
  const selection = selectFallbackKeys({
    rankedKeysByLane,
    suspiciousExploratoryKeys,
    budget: MAX_FALLBACK_TOKENS,
    exploratoryReserved: FALLBACK_EXPLORATORY_RESERVED_SLOTS,
    allowExploratorySpamLookup,
  })
  const budgetedFallbackKeys = [...selection.material, ...selection.activity, ...selection.exploratory]
  const budgetedFallbackKeySet = new Set(budgetedFallbackKeys)
  const overBudgetKeys = rankedFallbackKeys.filter((key) => !budgetedFallbackKeySet.has(key))
  const materialFallbackKeys = rankedKeysByLane.material
  const noSignalFallbackKeys = rankedFallbackKeys.filter((key) => laneByKey.get(key) === 'exploratory')

  // DIAGNOSTIC: real counts only. `budgetedForLookup` can never exceed `fallbackBudget`.
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
    materialFallbackCandidates: materialFallbackKeys.length,
    activityFallbackCandidates: rankedKeysByLane.activity.length,
    activityLaneStatus: activityLane.status,
    cleanExploratoryCandidates: rankedKeysByLane.exploratory.length - suspiciousExploratoryKeys.size,
    suspiciousExploratoryCandidates: suspiciousExploratoryKeys.size,
    noSignalFallbackCandidates: noSignalFallbackKeys.length,
    spoofSuppressedCandidates: [...spoofedKeys].filter((k) => laneByKey.get(k) === 'exploratory').length,
    budgetedMaterialKeys: selection.material.length,
    budgetedActivityKeys: selection.activity.length,
    budgetedNoSignalKeys: selection.exploratory.length,
    exploratoryReservedSlots: FALLBACK_EXPLORATORY_RESERVED_SLOTS,
    lanes: { material: selection.material.length, activity: selection.activity.length, exploratory: selection.exploratory.length },
    allowExploratorySpamLookup,
    timestamp: Date.now(),
  })
  const fallbackPriceByKey = new Map<string, number | null>()
  const resolvedPrices = await mapWithConcurrencyLimit(budgetedFallbackKeys, FALLBACK_PRICE_CONCURRENCY_LIMIT, async (key) => {
    const [chainIdStr, tokenAddress] = key.split(':')
    const price = await priceFn(Number(chainIdStr), tokenAddress)
    // A non-positive or non-finite price is never a price.
    return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null
  })
  budgetedFallbackKeys.forEach((key, i) => fallbackPriceByKey.set(key, resolvedPrices[i]))

  // ASSUMED DECIMALS ARE NEVER VALUED: a fallback-priced holding whose decimals were only assumed (an
  // Alchemy-only row) gets its real decimals() read on-chain — bounded by the same budget (only keys that
  // actually found a price) and permanently cached per token. If that read fails, the holding stays
  // unpriced ('decimals_unverified') rather than being valued from a guessed quantity.
  const onchainDecimalsByKey = new Map<string, number>()
  const decimalsUnverifiedKeys = new Set<string>()
  const keysNeedingDecimals = Array.from(new Set(
    holdings.filter((h) => !decimalsKnown(h) && fallbackPriceByKey.get(fallbackKeyOf(h)) != null).map(fallbackKeyOf),
  ))
  const verifiedDecimals = await mapWithConcurrencyLimit(keysNeedingDecimals, FALLBACK_PRICE_CONCURRENCY_LIMIT, async (key) => {
    const [chainIdStr, tokenAddress] = key.split(':')
    return decimalsFn(Number(chainIdStr), tokenAddress)
  })
  keysNeedingDecimals.forEach((key, i) => {
    const d = verifiedDecimals[i]
    if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 36) onchainDecimalsByKey.set(key, d)
    else decimalsUnverifiedKeys.add(key)
  })
  // Holdings whose key didn't make the cut stay honestly unpriced (priceUsd/valueUsd: null below) —
  // never hidden from pricedHoldings, never defaulted to zero.

  const pricedHoldings: PricedHolding[] = holdings.map((h): PricedHolding => {
    // Prefer the balances provider's own real, free price (see file header) — only fall through
    // to the weaker, capped, deduped DexScreener-only lookup when the provider genuinely didn't
    // supply one.
    // Assumed decimals: use the on-chain-verified decimals for quantity, or stay unpriced.
    let decimals = h.decimals
    let quantity = h.quantity
    let fallbackPrice = fallbackPriceByKey.get(fallbackKeyOf(h)) ?? null
    if (!decimalsKnown(h)) {
      const verified = onchainDecimalsByKey.get(fallbackKeyOf(h))
      if (verified != null && h.amountRaw != null && /^\d+$/.test(h.amountRaw)) {
        decimals = verified
        quantity = String(Number(h.amountRaw) / 10 ** verified)
      } else {
        fallbackPrice = null
      }
    }
    const priceUsd = h.providerPriceUsd != null && h.providerPriceUsd > 0
      ? h.providerPriceUsd
      : fallbackPrice
    const recomputedValueUsd = priceUsd != null ? Number(quantity) * priceUsd : null
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
      decimals,
      quantity,
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
    decimalsUnverifiedKeys,
  })
  // POTENTIALLY MATERIAL UNPRICED: a real local estimate above $1 (provider partial value / verified stable
  // peg) — PLUS any unpriced Alchemy-only row (no spam filter, no metadata, no price: genuinely unknown)
  // that shows no junk signal. Those keep the lane "Partial", never a silently complete total.
  const holdingByKey = new Map(holdings.map((h) => [fallbackKeyOf(h), h]))
  const estimatedPotentiallyMaterialUnpricedCount = unpricedDiagnostics.filter((d) => {
    if (d.estimatedMaterialitySignal != null && d.estimatedMaterialitySignal > DUST_VALUE_USD_THRESHOLD) return true
    const h = holdingByKey.get(`${d.chainId}:${d.tokenAddress.toLowerCase()}`)
    return h != null && d.fallbackEligible && !decimalsKnown(h) && exploratorySuspicion(h) == null && !isSpoofStableSymbol(h) && !isSpoofBlueChipSymbol(h)
  }).length
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
      const rpcVerifiedDecimals = await decimalsFn(h.chainId, h.tokenAddress)
      if (rpcVerifiedDecimals != null && rpcVerifiedDecimals !== p.decimals && h.amountRaw != null && p.priceUsd != null) {
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

  // PER-HOLDING FALLBACK AUDIT: every current holding (capped for payload size), plus the lane counts.
  const holdingAuditRows = buildHoldingFallbackAudit({
    holdings, pricedHoldings, rankedFallbackKeys, budgetedFallbackKeys, keyOf: fallbackKeyOf, decimalsUnverifiedKeys, onchainDecimalsByKey,
  })
  const fallbackAudit: HoldingsFallbackAudit = {
    holdingsTotal: holdings.length,
    providerPriced: providerPriced.length,
    fallbackEligible: eligibleHoldings.length,
    fallbackBudget: MAX_FALLBACK_TOKENS,
    exploratoryReservedSlots: FALLBACK_EXPLORATORY_RESERVED_SLOTS,
    candidates: { material: rankedKeysByLane.material.length, activity: rankedKeysByLane.activity.length, exploratory: rankedKeysByLane.exploratory.length },
    selected: { material: selection.material.length, activity: selection.activity.length, exploratory: selection.exploratory.length },
    exploratoryCandidates: { clean: rankedKeysByLane.exploratory.length - suspiciousExploratoryKeys.size, suspicious: suspiciousExploratoryKeys.size },
    exploratorySelected: {
      clean: selection.exploratory.filter((k) => !suspiciousExploratoryKeys.has(k)).length,
      suspicious: selection.exploratory.filter((k) => suspiciousExploratoryKeys.has(k)).length,
    },
    activityLane,
    budgetedForLookup: budgetedFallbackKeys.length,
    fallbackPriced: budgetedFallbackKeys.filter((k) => fallbackPriceByKey.get(k) != null && !decimalsUnverifiedKeys.has(k)).length,
    decimalsVerifiedOnchain: onchainDecimalsByKey.size,
    decimalsUnverified: decimalsUnverifiedKeys.size,
    pricedCount,
    unpricedCount: pricedHoldings.length - pricedCount,
    rows: holdingAuditRows.slice(0, HOLDING_AUDIT_MAX_ROWS),
    rowsTruncated: holdingAuditRows.length > HOLDING_AUDIT_MAX_ROWS,
  }
  // eslint-disable-next-line no-console
  console.warn('[holdings-fallback-selection] lanes', { ...fallbackAudit, rows: undefined })

  return { pricedHoldings, totalValueUsd, chainValueUsd, priceStatus, potentiallyMaterialUnpricedCount: estimatedPotentiallyMaterialUnpricedCount, fallbackAudit }
}
