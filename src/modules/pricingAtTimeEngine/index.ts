// MODULE — pricingAtTimeEngine
//
// Additive historical-USD-pricing pass over buyTimeline + sellTimelineV2 entries, keyed by real
// txHash. Does NOT modify fifoEngine or its own priceUsdLookup mechanism — this is a separate,
// standalone read model (see types.ts header for the full rationale).

import type {
  PriceableEntry,
  PricingAtTimeResult,
  ResolvePricingAtTimeParams,
  SourceBreakdown,
} from './types'
import { multiplyAmount, resolvePriceForEntry } from './utils'
import { logBaseDexFinalTotals } from './sources/basedex'

export type {
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
const PRICE_ENTRY_CONCURRENCY_LIMIT = 15

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

async function priceEntries(
  entries: PriceableEntry[],
  priceSources: ResolvePricingAtTimeParams['priceSources'],
): Promise<{ usdByTxHash: Record<string, number | null>; breakdown: SourceBreakdown; missing: number }> {
  const results = await mapWithConcurrencyLimit(entries, PRICE_ENTRY_CONCURRENCY_LIMIT, async (entry) => {
    const { price, source } = await resolvePriceForEntry(entry.token, entry.chain, entry.timestamp, priceSources)
    return { txHash: entry.txHash, usd: multiplyAmount(price, entry.amount), source, missing: price === null }
  })

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

// PURE (given deterministic priceSources responses). Resolves real historical USD pricing for
// every buy/sell entry independently, via caller-injected priceSources only. Never fabricates a
// price, a token/chain/timestamp, or a fallback source — a source that returns/throws null simply
// leaves that entry's costUsd/proceedsUsd as null and counts toward evidenceMissingCount.
export async function resolvePricingAtTime(params: ResolvePricingAtTimeParams): Promise<PricingAtTimeResult> {
  logFanOutSize('buys', params.buyEntries.length)
  logFanOutSize('sells', params.sellEntries.length)
  logDistinctTokenRatio(params.buyEntries, params.sellEntries)

  const [buys, sells] = await Promise.all([
    priceEntries(params.buyEntries, params.priceSources),
    priceEntries(params.sellEntries, params.priceSources),
  ])

  // FINAL-TOTALS SUMMARY, DISCLOSED: one line per scan reporting basedex's cumulative RPC counts,
  // fired once this scan's whole pricing pass finishes — replaces scrolling through hundreds of
  // per-call basedex lines to find the last one.
  logBaseDexFinalTotals()

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
