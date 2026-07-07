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
function logFanOutSize(kind: 'buys' | 'sells', count: number): void {
  // eslint-disable-next-line no-console
  console.log('[RPC-INVESTIGATION] pricingAtTimeEngine.priceEntries fan-out', { kind, entryCount: count, timestamp: Date.now() })
}

async function priceEntries(
  entries: PriceableEntry[],
  priceSources: ResolvePricingAtTimeParams['priceSources'],
): Promise<{ usdByTxHash: Record<string, number | null>; breakdown: SourceBreakdown; missing: number }> {
  const results = await Promise.all(
    entries.map(async (entry) => {
      const { price, source } = await resolvePriceForEntry(entry.token, entry.chain, entry.timestamp, priceSources)
      return { txHash: entry.txHash, usd: multiplyAmount(price, entry.amount), source, missing: price === null }
    }),
  )

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

  const [buys, sells] = await Promise.all([
    priceEntries(params.buyEntries, params.priceSources),
    priceEntries(params.sellEntries, params.priceSources),
  ])

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
