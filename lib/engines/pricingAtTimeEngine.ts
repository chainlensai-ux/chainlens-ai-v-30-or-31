// lib/engines/pricingAtTimeEngine.ts — PricingAtTimeEngine.
//
// NAMING/COLLISION DISCLOSURE: src/modules/pricingAtTimeEngine/ already exists in this codebase —
// a real, already-shipped, already-wired-into-runWalletScanV2 module that batch-prices WHOLE
// buyTimeline/sellTimeline arrays (keyed by txHash) using caller-injected PriceSourceFn functions.
// This is a genuinely different, new capability: a single-token/single-timestamp lookup with an
// explicit multi-provider evidence array and confidence score, which does not exist anywhere in
// this codebase today. Per "do not modify existing engines," this is a new, standalone, additive
// file — it does not touch, import from as a dependency-of, or change src/modules/
// pricingAtTimeEngine/index.ts, src/pipeline/index.ts, or runWalletScanV2 in any way. The 3
// provider adapters this engine calls (lib/providers/*.ts) reuse that existing module's real
// per-provider source functions internally (see each adapter's own header) rather than
// reimplementing the network calls — so this really is new orchestration/scoring logic layered on
// top of real, existing fetchers, not new business logic duplicating what already exists.
//
// SPEC NOTE ON THE OUTPUT CONTRACT, DISCLOSED: the requested `confidence` type includes "low" and
// the requested `source` type includes "fallback", but the requested confidence/priority rules
// never actually produce either value (rules only ever yield "high"/"medium"/"none", and priority
// is only ever goldrush/coingecko/onchain-dex). Both are kept in the types exactly as specified —
// they are simply unreachable given the literal rules given, not omitted.

import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { fetchGoldrushHistoricalPrice } from '@/lib/providers/goldrush'
import { fetchCoingeckoHistoricalPrice } from '@/lib/providers/coingecko'
import { fetchOnchainDexPriceAtTime } from '@/lib/providers/onchainDex'

export type PricingAtTimeRequest = {
  chain: SupportedChain
  tokenAddress: string
  timestamp: number // unix seconds
}

export type PricingSourceName = 'goldrush' | 'coingecko' | 'onchain-dex' | 'fallback'

export type PricingConfidence = 'high' | 'medium' | 'low' | 'none'

export type EvidenceEntry = {
  provider: string
  priceUsd: number | null
  timestamp: number
  notes?: string
}

export type PricingAtTimeResult = {
  priceUsd: number | null
  source: PricingSourceName | null
  confidence: PricingConfidence
  evidence: EvidenceEntry[]
}

// Provider priority when multiple sources return a non-null price — goldrush first, coingecko
// second, onchain-dex third, exactly as specified.
const PROVIDER_PRIORITY: PricingSourceName[] = ['goldrush', 'coingecko', 'onchain-dex']

// Public entry point. Calls all 3 providers in parallel; never throws (each adapter already
// gracefully resolves to { priceUsd: null } on any failure, and this function does not re-throw).
export async function getPriceAtTime(req: PricingAtTimeRequest): Promise<PricingAtTimeResult> {
  const [goldrush, coingecko, onchainDex] = await Promise.all([
    fetchGoldrushHistoricalPrice(req),
    fetchCoingeckoHistoricalPrice(req),
    fetchOnchainDexPriceAtTime(req),
  ])

  const byProvider: Record<Exclude<PricingSourceName, 'fallback'>, { priceUsd: number | null; timestamp: number; notes?: string }> = {
    goldrush,
    coingecko,
    'onchain-dex': onchainDex,
  }

  // Evidence array: only non-null results, per spec step 2.
  const evidence: EvidenceEntry[] = (Object.keys(byProvider) as Array<Exclude<PricingSourceName, 'fallback'>>)
    .filter((name) => byProvider[name].priceUsd !== null)
    .map((name) => ({
      provider: name,
      priceUsd: byProvider[name].priceUsd,
      timestamp: byProvider[name].timestamp,
      notes: byProvider[name].notes,
    }))

  if (evidence.length === 0) {
    return { priceUsd: null, source: null, confidence: 'none', evidence: [] }
  }

  const chosenProvider = PROVIDER_PRIORITY.find((name) => evidence.some((e) => e.provider === name))
  const chosen = evidence.find((e) => e.provider === chosenProvider)!

  const confidence: PricingConfidence = evidence.length >= 2 ? 'high' : 'medium'

  return {
    priceUsd: chosen.priceUsd,
    source: chosen.provider as PricingSourceName,
    confidence,
    evidence,
  }
}
