// lib/engines/unrealizedPnlEngine.ts — UnrealizedPnlEngine.
//
// STANDALONE, ADDITIVE — not wired into scan-v2 or runWalletScanV2 yet, per request. Depends only
// on lib/engines/pricingAtTimeEngine.ts (already built, also standalone/unwired).
//
// REQUIRED CORRECTION, DISCLOSED: the requested `Holding` type had no acquisition-timestamp field
// at all, but this engine's own step 1 ("fetch historical cost basis using PricingAtTimeEngine")
// is structurally impossible without one — getPriceAtTime() requires {chain, tokenAddress,
// timestamp}. Added the minimal missing field (`acquiredAtTimestamp: number`, unix seconds) rather
// than fabricating a fake timestamp (e.g. "now", which would make cost basis equal current price
// and every holding report exactly $0 unrealized PnL — silently defeating the entire purpose of
// this engine) or guessing one from elsewhere. This is the one addition beyond the literal spec;
// everything else follows the request exactly.
//
// NOTE ON REAL EXISTING INFRASTRUCTURE: this session already built lib/modules/lotOpener +
// lotCloser, whose IntentLot type already carries a real timestamp + real costBasis for open
// (unclosed) lots — a more accurate source of "cost basis for open lots" than re-deriving it here
// via a fresh historical-price lookup. This engine still follows the literal request (a flat
// Holding[] input, pricing looked up via PricingAtTimeEngine) rather than switching to IntentLot[],
// since redesigning the input contract was explicitly out of scope here. Worth revisiting when this
// engine is actually wired up, if lot-accurate cost basis is preferred over a re-derived price.
//
// HONESTY NOTE ON THE "NO PRICE FOUND" CASE: when PricingAtTimeEngine returns confidence "none"
// (no provider had a historical price), costBasisUsd is reported as 0 and unrealizedPnlUsd equals
// currentValueUsd in the literal numeric fields — but confidence is also "none" and evidence is
// empty for that same token, which is the honest signal that these two numbers are NOT a real
// 100% gain and should not be trusted without real cost-basis evidence. This mirrors the same
// "number field always present, confidence/evidence carry the real honesty signal" pattern already
// used by lib/modules/lotOpener and lotCloser this session — never silently fabricating a
// confident-looking PnL number, but also never omitting the required numeric field.

import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { getPriceAtTime, type EvidenceEntry, type PricingConfidence } from '@/lib/engines/pricingAtTimeEngine'

export type Holding = {
  tokenAddress: string
  chain: SupportedChain
  amount: number
  currentPriceUsd: number
  currentValueUsd: number
  /** ADDED — see module header. Unix seconds; when this holding's lot was opened/acquired. */
  acquiredAtTimestamp: number
}

export type UnrealizedPnlRequest = {
  chain: SupportedChain
  walletAddress: string
  holdings: Holding[]
}

export type TokenUnrealizedPnl = {
  tokenAddress: string
  chain: SupportedChain
  amount: number
  costBasisUsd: number
  currentValueUsd: number
  unrealizedPnlUsd: number
  confidence: PricingConfidence
  evidence: EvidenceEntry[]
}

export type UnrealizedPnlResult = {
  totalUnrealizedPnlUsd: number
  tokens: TokenUnrealizedPnl[]
}

async function computeTokenPnl(holding: Holding): Promise<TokenUnrealizedPnl> {
  const priceResult = await getPriceAtTime({
    chain: holding.chain,
    tokenAddress: holding.tokenAddress,
    timestamp: holding.acquiredAtTimestamp,
  })

  // priceResult.priceUsd is null exactly when confidence is "none" / evidence is empty — see
  // module header's honesty note for why costBasisUsd still resolves to a real number (0) here
  // rather than null, and why the confidence/evidence fields are what actually carry the "this
  // number isn't real evidence" signal to the caller.
  const priceAtTime = priceResult.priceUsd ?? 0
  const costBasisUsd = holding.amount * priceAtTime
  const currentValueUsd = holding.amount * holding.currentPriceUsd
  const unrealizedPnlUsd = currentValueUsd - costBasisUsd

  return {
    tokenAddress: holding.tokenAddress,
    chain: holding.chain,
    amount: holding.amount,
    costBasisUsd,
    currentValueUsd,
    unrealizedPnlUsd,
    confidence: priceResult.confidence,
    evidence: priceResult.evidence,
  }
}

// Public entry point. Pricing lookups run in parallel across holdings (each internally already
// runs its 3 providers in parallel — see pricingAtTimeEngine.ts). Never throws: getPriceAtTime()
// already gracefully resolves to a "none confidence" result on any failure.
export async function computeUnrealizedPnl(req: UnrealizedPnlRequest): Promise<UnrealizedPnlResult> {
  const tokens = await Promise.all(req.holdings.map(computeTokenPnl))
  const totalUnrealizedPnlUsd = tokens.reduce((sum, t) => sum + t.unrealizedPnlUsd, 0)
  return { totalUnrealizedPnlUsd, tokens }
}
