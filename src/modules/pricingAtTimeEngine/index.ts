// MODULE — pricingAtTimeEngine
//
// Additive historical-USD-pricing pass over buyTimeline + sellTimelineV2 entries, keyed by real
// txHash. Does NOT modify fifoEngine or its own priceUsdLookup mechanism — this is a separate,
// standalone read model (see types.ts header for the full rationale).

import type {
  FallbackPricingConfig,
  PriceableEntry,
  PricingAtTimeResult,
  ResolvePricingAtTimeParams,
  SourceBreakdown,
} from './types'
import { multiplyAmount, resolvePriceForEntry } from './utils'
import { logBaseDexFinalTotals } from './sources/basedex'
import { getGoldrushPriceSourceCallCount } from './sources/goldrushPriceSource'

export type {
  FallbackPricingAttemptFn,
  FallbackPricingConfig,
  FallbackPricingRoute,
  PriceableEntry,
  PriceSourceFn,
  PriceSources,
  PriceSourceUsed,
  PricingAtTimeResult,
  ResolvePricingAtTimeParams,
  SourceBreakdown,
} from './types'

// INSTRUMENTATION, DISCLOSED (eth_getBlockByNumber/eth_call runaway-investigation task): a single,
// non-invasive log per call — no timeout, budget, retry, or business-logic change. Reports exactly
// how many entries are about to fan out via Promise.all below with zero concurrency cap, which is
// the real, statically-identified candidate for the reported call volume (see basedex.ts's own
// counters for the downstream per-entry RPC cost).
//
// console.warn, NOT console.log, DISCLOSED (found live, this task): next.config's
// `compiler.removeConsole` strips console.log/info/debug entirely out of the production build
// (`exclude: ['error', 'warn']` is the only thing kept) — confirmed live by the user: this file's
// original console.log version never appeared in Vercel logs on ANY deployment, while this exact
// codebase's own pre-existing console.warn lines (e.g. "[pipeline] buildPriceSources...") did.
// Using console.warn here so this instrumentation actually survives the real build, matching that
// same real, pre-existing constraint.
function logFanOutSize(kind: 'buys' | 'sells', count: number): void {
  // eslint-disable-next-line no-console
  console.warn('[RPC-INVESTIGATION] pricingAtTimeEngine.priceEntries fan-out', { kind, entryCount: count, timestamp: Date.now() })
}

// DISTINCT-TOKEN CHECK, DISCLOSED (real-CU-fix investigation, applied per user request): read-only
// diagnostic — no behavior change. Reports how much repeat-token trading exists in this scan's
// entries, which decides whether a negative-result cache for basedex's resolvePoolAddress (real
// fix candidate, not yet built) would meaningfully cut cost or not: it only helps for tokens that
// get looked up more than once. Counts distinct (chain, token) pairs vs total entries across BOTH
// buys and sells combined (a token traded on both sides counts once per side's own entry list here
// — deliberately per-list, matching how priceEntries() itself processes buys/sells separately).
function logDistinctTokenRatio(buyEntries: PriceableEntry[], sellEntries: PriceableEntry[]): void {
  const allEntries = [...buyEntries, ...sellEntries]
  const distinctTokens = new Set(allEntries.map((e) => `${e.chain}:${e.token.toLowerCase()}`))
  // eslint-disable-next-line no-console
  console.warn('[RPC-INVESTIGATION] pricingAtTimeEngine distinct-token ratio', {
    totalEntries: allEntries.length,
    distinctTokens: distinctTokens.size,
    // How many times, on average, each distinct token is looked up — >1 means real repeat-token
    // trading exists, and a negative-result cache would have real savings to offer.
    avgLookupsPerToken: allEntries.length > 0 ? Number((allEntries.length / distinctTokens.size).toFixed(2)) : 0,
    timestamp: Date.now(),
  })
}

// CONCURRENCY CAP, DISCLOSED (real-CU-fix, applied live per user confirmation of the measured
// production evidence — see this file's INSTRUMENTATION comment above for the confirmed numbers:
// one scan queued 733 entries, fired all at once, and drove 250+ real Alchemy calls in under 2
// seconds via the basedex fallback). ZERO correctness/precision change: every entry still gets the
// exact same resolvePriceForEntry() call, in the same order, with the same inputs — only how many
// run AT ONCE changes. This also directly addresses part of the ROOT cause, not just basedex's own
// cost: firing hundreds of concurrent requests at CoinGecko's public API (which has real,
// well-known per-minute rate limits) very plausibly causes widespread false 429 "misses" that have
// nothing to do with whether CoinGecko actually has the token's price — those false misses are
// exactly what pushes so many entries into the expensive basedex path in the first place. Capping
// concurrency gives GoldRush/DexScreener/CoinGecko a real chance to succeed instead of being
// rate-limited into failure, which should reduce how often basedex is even reached, in addition to
// preventing the burst itself.
//
// RAISED 15 -> 30, DISCLOSED (scan-latency task, per explicit user request to trade some of that
// safety margin back for speed): since then, basedex.ts itself gained real negative-result caching,
// Multicall3 batching, and a smarter block-search — so a given burst of concurrent entries now
// drives meaningfully fewer real downstream calls than when 15 was chosen, leaving more headroom
// before hitting the same false-429 risk this cap was originally guarding against. This is
// explicitly a speed-for-safety-margin trade, not a free win — if it produces new rate-limit
// failures in practice, that's the signal to dial it back down, not push it higher.
const PRICE_ENTRY_CONCURRENCY_LIMIT = 30

// PER-TOKEN LOOKUP CAP, DISCLOSED (fan-out throttle, additive/scoped to this module only): once a
// given (chain,token) pair has been resolved MAX_LOOKUPS_PER_TOKEN times within one
// resolvePricingAtTime call, every FURTHER entry for that same token is left unpriced
// (costUsd/proceedsUsd null, counted in evidenceMissingCount) instead of either (a) making another
// real downstream call — the exact fan-out this cap exists to reduce — or (b) reusing an earlier
// lookup's price for a DIFFERENT timestamp, which would be exactly the "never fabricate a price"
// violation this codebase has refused everywhere else (a token's price at 9am is not its price at
// 3pm). Real tradeoff, not a free win: a heavily-repeat-traded token's later entries go from
// "possibly priced" to "definitely unpriced" once the cap is hit — logged per-scan so this is
// visible, not silent. This module has NO connection to pnlV2/fifoEngine (see this module's own
// types.ts header) — only pricingAtTime's own additive costUsd/proceedsUsd/evidenceMissingCount
// read model is affected, never any pnlV2/FIFO/cost-basis number.
const MAX_LOOKUPS_PER_TOKEN_DEFAULT = 2
// DENSE-CAP FIX, DISCLOSED (confirmed bug, real production evidence — distinctTokenCount: 128 with
// cappedCount: 225): this was previously 1, meaning a wallet above DENSE_TOKEN_THRESHOLD got exactly
// ONE lookup per token TOTAL, across its combined buy+sell entries (buys are listed first in the
// tagged array below, so a token's own SELL entry — needed for a closed lot's proceedsUsd — always
// lost the cap to that same token's earlier BUY entry). A closed lot structurally needs at minimum
// two distinct timestamp lookups (its buy AND its sell) to ever become fully priced; capping at 1
// made it IMPOSSIBLE for any lot of a dense wallet to ever get both costUsd and proceedsUsd, which is
// a direct, sufficient explanation for realizedPnlUsd staying null despite hundreds of real matched
// lots. Raised to 2 — the minimum needed for one round-trip (buy+sell) per token to both price — a
// token traded more than twice still has its 3rd+ occurrence honestly capped/unpriced, same
// disclosed tradeoff as before, just no longer structurally guaranteed to block 100% of proceeds.
// Cost impact: bounded, proportional to the wallet's own distinct token count — up to
// +distinctTokenCount additional real provider calls in the worst case for dense wallets specifically
// (previously-capped second-occurrence lookups can now proceed instead of returning null instantly);
// non-dense wallets (<=120 distinct tokens) are unaffected, this only raises the DENSE tier.
const MAX_LOOKUPS_PER_TOKEN_DENSE = 2 // used when distinctTokenCount > DENSE_TOKEN_THRESHOLD
const DENSE_TOKEN_THRESHOLD = 120

// Pure, exported for direct testing.
export function resolveMaxLookupsPerToken(distinctTokenCount: number): number {
  return distinctTokenCount > DENSE_TOKEN_THRESHOLD ? MAX_LOOKUPS_PER_TOKEN_DENSE : MAX_LOOKUPS_PER_TOKEN_DEFAULT
}

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function summarizeEntryResults(results: Array<{ txHash: string; usd: number | null; source: keyof SourceBreakdown; missing: boolean }>) {
  const usdByTxHash: Record<string, number | null> = {}
  const breakdown: SourceBreakdown = { primary: 0, fallback: 0, failed: 0 }
  let missing = 0

  for (const r of results) {
    usdByTxHash[r.txHash] = r.usd
    breakdown[r.source] += 1
    if (r.missing) missing += 1
  }

  return { usdByTxHash, breakdown, missing }
}

// CONCURRENCY CAP FIX, DISCLOSED: previously, buys and sells each ran through their own independent
// mapWithConcurrencyLimit(entries, PRICE_ENTRY_CONCURRENCY_LIMIT, ...) call, launched concurrently
// via Promise.all below. Two pools of up to 30 workers each meant a scan with large buy AND sell
// lists could drive up to ~60 simultaneous downstream price-source calls — silently double the
// burst PRICE_ENTRY_CONCURRENCY_LIMIT was raised/tuned to allow, reintroducing exactly the
// false-429 risk this cap exists to prevent. Fixed by combining buy+sell entries into one shared
// worker pool capped at PRICE_ENTRY_CONCURRENCY_LIMIT total, tagging each entry with its list so
// results can still be split back into separate buy/sell breakdowns afterward.
async function priceAllEntries(
  buyEntries: PriceableEntry[],
  sellEntries: PriceableEntry[],
  priceSources: ResolvePricingAtTimeParams['priceSources'],
  fallbackPricing: FallbackPricingConfig | undefined,
): Promise<{
  buys: { usdByTxHash: Record<string, number | null>; breakdown: SourceBreakdown; missing: number }
  sells: { usdByTxHash: Record<string, number | null>; breakdown: SourceBreakdown; missing: number }
}> {
  const tagged = [
    ...buyEntries.map((entry) => ({ entry, list: 'buy' as const })),
    ...sellEntries.map((entry) => ({ entry, list: 'sell' as const })),
  ]

  const distinctTokenCount = new Set(tagged.map(({ entry }) => `${entry.chain}:${entry.token.toLowerCase()}`)).size
  const maxLookupsPerToken = resolveMaxLookupsPerToken(distinctTokenCount)
  const lookupCountByToken = new Map<string, number>()
  let cappedCount = 0

  // Synchronous increment-and-check BEFORE the `await` below — safe/atomic within JS's single
  // event loop even though many of these workers run "concurrently": no other worker's code runs
  // between this increment and the cap comparison, only between one worker's `await` and the next.
  const results = await mapWithConcurrencyLimit(tagged, PRICE_ENTRY_CONCURRENCY_LIMIT, async ({ entry, list }) => {
    const tokenKey = `${entry.chain}:${entry.token.toLowerCase()}`
    const priorLookups = lookupCountByToken.get(tokenKey) ?? 0
    if (priorLookups >= maxLookupsPerToken) {
      cappedCount += 1
      return { list, txHash: entry.txHash, usd: null, source: 'failed' as const, missing: true }
    }
    lookupCountByToken.set(tokenKey, priorLookups + 1)

    const { price, source } = await resolvePriceForEntry(entry.token, entry.chain, entry.timestamp, priceSources)

    // EXTERNAL FALLBACK, OPTIONAL/ADDITIVE, DISCLOSED: only reached when `fallbackPricing` was
    // supplied (never true for priceLotsForWallet.ts's calls — see types.ts's own disclosure) AND
    // priceSources' own primary+fallback both already missed. Never overrides a real price
    // priceSources itself found; never a third attempt beyond primary+fallback in the sense that
    // matters for cost-basis (this whole branch is unreachable for the fifoEngine-feeding caller).
    if (price === null && fallbackPricing) {
      const attempt = await fallbackPricing.attempt({ chain: entry.chain, tokenAddress: entry.token, timestampMs: entry.timestamp })
      const route = attempt.ok ? attempt.source : 'failed'
      fallbackPricing.onRouteRecorded?.({ token: entry.token, chain: entry.chain, timestamp: entry.timestamp, route })
      if (attempt.ok) {
        return { list, txHash: entry.txHash, usd: multiplyAmount(attempt.priceUsd, entry.amount), source: 'fallback' as const, missing: false }
      }
    }

    return { list, txHash: entry.txHash, usd: multiplyAmount(price, entry.amount), source, missing: price === null }
  })

  if (cappedCount > 0) {
    // eslint-disable-next-line no-console
    console.warn('[RPC-INVESTIGATION] pricingAtTimeEngine per-token lookup cap applied', {
      distinctTokenCount, maxLookupsPerToken, cappedCount, timestamp: Date.now(),
    })
  }

  return {
    buys: summarizeEntryResults(results.filter((r) => r.list === 'buy')),
    sells: summarizeEntryResults(results.filter((r) => r.list === 'sell')),
  }
}

// PURE (given deterministic priceSources responses). Resolves real historical USD pricing for
// every buy/sell entry independently, via caller-injected priceSources only. Never fabricates a
// price, a token/chain/timestamp, or a fallback source — a source that returns/throws null simply
// leaves that entry's costUsd/proceedsUsd as null and counts toward evidenceMissingCount.
export async function resolvePricingAtTime(params: ResolvePricingAtTimeParams): Promise<PricingAtTimeResult> {
  logFanOutSize('buys', params.buyEntries.length)
  logFanOutSize('sells', params.sellEntries.length)
  logDistinctTokenRatio(params.buyEntries, params.sellEntries)

  const { buys, sells } = await priceAllEntries(params.buyEntries, params.sellEntries, params.priceSources, params.fallbackPricing)

  // FINAL-TOTALS SUMMARY, DISCLOSED: one line per scan reporting basedex's cumulative RPC counts,
  // fired once this scan's whole pricing pass finishes — replaces scrolling through hundreds of
  // per-call basedex lines to find the last one.
  logBaseDexFinalTotals()

  // GOLDRUSH FINAL-TOTALS SUMMARY, DISCLOSED (GoldRush CU-investigation task): same pattern —
  // reports the primary GoldRush price-source's cumulative real (cache-miss) call count for this
  // scan's whole pricing pass, since this is the GoldRush call site most likely to fan out to real
  // volume in a deep scan (one call per distinct token/timestamp not already cached).
  // eslint-disable-next-line no-console
  console.warn('[GOLDRUSH-INVESTIGATION] pricingAtTimeEngine FINAL TOTALS', {
    goldrushPriceSourceCalls: getGoldrushPriceSourceCallCount(),
    timestamp: Date.now(),
  })

  return {
    costUsd: buys.usdByTxHash,
    proceedsUsd: sells.usdByTxHash,
    evidenceMissingCount: buys.missing + sells.missing,
    sourceBreakdown: {
      primary: buys.breakdown.primary + sells.breakdown.primary,
      fallback: buys.breakdown.fallback + sells.breakdown.fallback,
      failed: buys.breakdown.failed + sells.breakdown.failed,
    },
  }
}
