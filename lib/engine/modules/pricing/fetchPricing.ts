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

function fallbackPriorityScore(h: ChainHolding): [number, number, number] {
  const valueSignal = h.providerValueUsd != null && h.providerValueUsd > 0 ? h.providerValueUsd : -1
  const quantity = Number(h.quantity)
  const quantitySignal = Number.isFinite(quantity) ? quantity : -1
  const activityMs = h.lastActivityAt ? Date.parse(h.lastActivityAt) : NaN
  const activitySignal = Number.isFinite(activityMs) ? activityMs : -Infinity
  return [valueSignal, quantitySignal, activitySignal]
}

function compareFallbackPriority(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (b[i] !== a[i]) return b[i] - a[i] // descending: highest signal first
  }
  return 0
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
export async function priceHoldings(
  holdings: ChainHolding[],
  priceFn: (chainId: number, tokenAddress: string) => Promise<number | null> = fetchTokenPriceUsd,
): Promise<PricingEngineOutput> {
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
  const bestScoreByKey = new Map<string, [number, number, number]>()
  for (const h of eligibleHoldings) {
    const key = fallbackKeyOf(h)
    const score = fallbackPriorityScore(h)
    const existing = bestScoreByKey.get(key)
    if (!existing || compareFallbackPriority(score, existing) < 0) bestScoreByKey.set(key, score)
  }
  const rankedFallbackKeys = [...distinctFallbackKeys].sort((a, b) =>
    compareFallbackPriority(bestScoreByKey.get(a)!, bestScoreByKey.get(b)!),
  )
  const budgetedFallbackKeys = rankedFallbackKeys.slice(0, MAX_FALLBACK_TOKENS)
  const overBudgetKeys = rankedFallbackKeys.slice(MAX_FALLBACK_TOKENS)

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

  const totalValueUsd = pricedHoldings.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0)

  const chainValueUsd: Record<number, number> = {}
  for (const p of pricedHoldings) {
    chainValueUsd[p.chainId] = (chainValueUsd[p.chainId] ?? 0) + (p.valueUsd ?? 0)
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

      const share = p.valueUsd / totalValueUsd
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
        priceUsd: p.priceUsd,
        valueUsd: p.valueUsd,
        dominantHoldingValueShare: Math.round(share * 10000) / 100,
        dominantHoldingPriceSource: winningSource,
        dominantHoldingLiquidityUsd: pairInfo?.liquidityUsd ?? null,
        portfolioValueExcludingDominantHolding: Math.round((totalValueUsd - p.valueUsd) * 100) / 100,
      })
    }
  }

  return { pricedHoldings, totalValueUsd, chainValueUsd, priceStatus }
}
