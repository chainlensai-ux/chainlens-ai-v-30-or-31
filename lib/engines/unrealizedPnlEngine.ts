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
// CLAMP/MISSING-EVIDENCE FIX, DISCLOSED (safety-hardening task, replaces the "HONESTY NOTE" this
// used to say): that note described a real, disclosed weakness, not just a style choice — a "none
// confidence" (no historical price found) token previously reported costBasisUsd=0 and
// unrealizedPnlUsd=currentValueUsd, i.e. a fabricated-looking "100% gain" number in the one field
// most consumers actually read, with only the separate confidence/evidence fields signaling it
// wasn't real. Fixed below: costBasisUsd/unrealizedPnlUsd are now null and
// `integrity: 'missing_cost_basis'` when no real historical price was found, instead of silently
// defaulting to 0 and fabricating a gain. Also added: a $1e9 clamp on the extreme end, and a
// sanity guard rejecting any price outside ($0, $1e6].
//
// SCOPE LIMITATION, DISCLOSED: the task requesting this fix also asked to flag conditions like
// "sells but no buys," "router-only outbound transfers," "missing liquidity/pool indexing," etc.
// None of that data exists anywhere in this file's scope — this engine's own header already
// discloses it is STANDALONE and NOT wired into runWalletScanV2/fifoEngine/sellTimelineV2/
// buyTimeline at all; its only input is a flat `Holding[]` snapshot (current amount + current
// price + acquisition timestamp), with no buy/sell event history and no router/liquidity/metadata
// data to check those conditions against. The closest honest equivalent this engine CAN check is
// its own real `confidence`/`evidence` signal from pricingAtTimeEngine (was real historical pricing
// evidence found at all) — implemented below as `integrity: 'missing_evidence'` when a current
// price itself fails the sanity guard.

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

// PnlIntegrity, ADDED, DISCLOSED: 'ok' means a real cost basis was found and the resulting PnL
// (possibly clamped) is safe to render; 'missing_cost_basis' means no historical price evidence
// existed at the acquisition timestamp; 'missing_evidence' means the CURRENT price itself failed
// the sanity guard (<=$0 or >$1e6) — either way unrealizedPnlUsd/costBasisUsd are null, never a
// fabricated number.
export type PnlIntegrity = 'ok' | 'missing_cost_basis' | 'missing_evidence'

const UNREALIZED_PNL_CLAMP_USD = 1e9
const MAX_VALID_USD_PRICE = 1e6

export type TokenUnrealizedPnl = {
  tokenAddress: string
  chain: SupportedChain
  amount: number
  costBasisUsd: number | null
  currentValueUsd: number
  unrealizedPnlUsd: number | null
  confidence: PricingConfidence
  evidence: EvidenceEntry[]
  integrity: PnlIntegrity
}

export type UnrealizedPnlResult = {
  // Sum over only tokens with integrity 'ok' (real cost basis, non-null PnL) — a token excluded
  // for missing evidence/cost-basis never silently contributes 0 or a fabricated value here.
  totalUnrealizedPnlUsd: number
  tokens: TokenUnrealizedPnl[]
  // Real analog of "Excluded from PnL" — token addresses whose unrealizedPnlUsd is null, for a
  // caller that wants to render an exclusion list. This engine has no portfolio-value/
  // concentration concept of its own to exclude these from (it isn't wired to one — see file
  // header), so this is as far as "requirement 5" can honestly reach from here.
  excludedFromPnl: string[]
}

function isSanePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price <= MAX_VALID_USD_PRICE
}

async function computeTokenPnl(holding: Holding): Promise<TokenUnrealizedPnl> {
  const priceResult = await getPriceAtTime({
    chain: holding.chain,
    tokenAddress: holding.tokenAddress,
    timestamp: holding.acquiredAtTimestamp,
  })

  const currentValueUsd = holding.amount * holding.currentPriceUsd

  // SANITY GUARD: a current price outside ($0, $1e6] is provider garbage — never fabricate PnL
  // from it, regardless of what the historical lookup found.
  if (!isSanePrice(holding.currentPriceUsd)) {
    // eslint-disable-next-line no-console
    console.warn('pnl_missing_evidence', { tokenAddress: holding.tokenAddress, chain: holding.chain, reason: 'current_price_out_of_range', currentPriceUsd: holding.currentPriceUsd })
    return {
      tokenAddress: holding.tokenAddress,
      chain: holding.chain,
      amount: holding.amount,
      costBasisUsd: null,
      currentValueUsd,
      unrealizedPnlUsd: null,
      confidence: priceResult.confidence,
      evidence: priceResult.evidence,
      integrity: 'missing_evidence',
    }
  }

  // priceResult.priceUsd is null exactly when confidence is "none" / evidence is empty — no real
  // historical price was found. Previously this defaulted costBasisUsd to 0, fabricating a
  // "100% gain" PnL number (see file header). Now honestly null instead.
  if (priceResult.priceUsd == null || !isSanePrice(priceResult.priceUsd)) {
    // eslint-disable-next-line no-console
    console.warn('pnl_missing_cost_basis', { tokenAddress: holding.tokenAddress, chain: holding.chain, priceAtTime: priceResult.priceUsd })
    return {
      tokenAddress: holding.tokenAddress,
      chain: holding.chain,
      amount: holding.amount,
      costBasisUsd: null,
      currentValueUsd,
      unrealizedPnlUsd: null,
      confidence: priceResult.confidence,
      evidence: priceResult.evidence,
      integrity: 'missing_cost_basis',
    }
  }

  const costBasisUsd = holding.amount * priceResult.priceUsd
  let unrealizedPnlUsd = currentValueUsd - costBasisUsd

  // CLAMP: an absurd/astronomical value past +-$1e9 is treated as a computation artifact, not a
  // real PnL figure — clamped, not nulled (a real, if extreme, gain/loss direction is preserved).
  // Structured log includes both the raw (pre-clamp) and clamped value, plus an explicit `reason`
  // field, alongside the event-name convention (first console.warn arg) already used throughout
  // this codebase's other safety-hardening logs (kv_timeout_safe, kv_disabled_for_request, etc.).
  if (unrealizedPnlUsd > UNREALIZED_PNL_CLAMP_USD) {
    const rawValue = unrealizedPnlUsd
    unrealizedPnlUsd = UNREALIZED_PNL_CLAMP_USD
    // eslint-disable-next-line no-console
    console.warn('pnl_clamped_high', { tokenAddress: holding.tokenAddress, chain: holding.chain, rawValue, clampedValue: unrealizedPnlUsd, reason: 'pnl_clamped_high' })
  } else if (unrealizedPnlUsd < -UNREALIZED_PNL_CLAMP_USD) {
    const rawValue = unrealizedPnlUsd
    unrealizedPnlUsd = -UNREALIZED_PNL_CLAMP_USD
    // eslint-disable-next-line no-console
    console.warn('pnl_clamped_low', { tokenAddress: holding.tokenAddress, chain: holding.chain, rawValue, clampedValue: unrealizedPnlUsd, reason: 'pnl_clamped_low' })
  }

  return {
    tokenAddress: holding.tokenAddress,
    chain: holding.chain,
    amount: holding.amount,
    costBasisUsd,
    currentValueUsd,
    unrealizedPnlUsd,
    confidence: priceResult.confidence,
    evidence: priceResult.evidence,
    integrity: 'ok',
  }
}

// Public entry point. Pricing lookups run in parallel across holdings (each internally already
// runs its 3 providers in parallel — see pricingAtTimeEngine.ts). Never throws: getPriceAtTime()
// already gracefully resolves to a "none confidence" result on any failure.
export async function computeUnrealizedPnl(req: UnrealizedPnlRequest): Promise<UnrealizedPnlResult> {
  const tokens = await Promise.all(req.holdings.map(computeTokenPnl))

  // Sum strictly over integrity === 'ok' tokens — never a null-coalesced 0 for an excluded token,
  // per this task's explicit "never treat null as 0" requirement. `okTokens` narrows
  // unrealizedPnlUsd to `number` (not `number | null`), so this is a real number the whole way
  // through, not an incidental effect of ?? 0 summing to the same total.
  const okTokens = tokens.filter((t): t is TokenUnrealizedPnl & { unrealizedPnlUsd: number } => t.integrity === 'ok')
  const totalUnrealizedPnlUsd = okTokens.reduce((sum, t) => sum + t.unrealizedPnlUsd, 0)

  // excludedFromPnl MUST include every token with integrity !== 'ok' — defined directly against
  // integrity (not inferred from nullness) so the two can never drift apart.
  const excludedFromPnl = tokens.filter((t) => t.integrity !== 'ok').map((t) => t.tokenAddress)

  return { totalUnrealizedPnlUsd, tokens, excludedFromPnl }
}
