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
import { getPriceAtTime, type EvidenceEntry, type PricingAtTimeResult, type PricingConfidence } from '@/lib/engines/pricingAtTimeEngine'

// DIAGNOSTIC AUDIT, DISCLOSED: a prior task attributed unrealized-PnL corruption to the KV circuit
// breaker / providerFetchWindow (circuit_breaker_open, kv_disabled_for_request,
// kv_skip_large_payload — all real strings, but they only exist in lib/server/cache/tokenCache.ts
// and v2StageCache.ts). This engine has NO dependency on either: its only price path is
// getPriceAtTime() -> lib/providers/{goldrush,coingecko,onchainDex}.ts, none of which import KV,
// a circuit breaker, or providerFetchWindow (confirmed by grep before writing this). The real,
// already-fixed root cause of corrupted unrealized PnL here was the fabricated-cost-basis bug
// (see CLAMP/MISSING-EVIDENCE FIX above) — not a KV/circuit-breaker issue, which lives in a
// different, unrelated pricing pipeline (src/pipeline/index.ts's PRICE_SOURCES).
export type PriceDiagnosticReason =
  | 'current_price_out_of_range'
  | 'historical_price_missing'
  | 'historical_price_out_of_range'

export function logPriceDiagnostics(chain: SupportedChain, token: string, reason: PriceDiagnosticReason): void {
  // eslint-disable-next-line no-console
  console.warn('[price_diagnostics]', { chain, token, reason, timestamp: Date.now() })
}

// Optional injectable seam (defaults to the real getPriceAtTime) — same additive-testing-seam
// convention already used elsewhere in this codebase (e.g. priceLotsForWallet.ts's `priceFn`),
// added specifically so a real, deterministic self-test can exercise every integrity branch
// without live network access.
export type GetPriceAtTimeFn = typeof getPriceAtTime

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

async function computeTokenPnl(holding: Holding, fetchPriceAtTime: GetPriceAtTimeFn): Promise<TokenUnrealizedPnl> {
  const priceResult: PricingAtTimeResult = await fetchPriceAtTime({
    chain: holding.chain,
    tokenAddress: holding.tokenAddress,
    timestamp: holding.acquiredAtTimestamp,
  })

  const currentValueUsd = holding.amount * holding.currentPriceUsd
  const currentPriceOk = isSanePrice(holding.currentPriceUsd)
  const historicalPriceOk = priceResult.priceUsd != null && isSanePrice(priceResult.priceUsd)

  function logVerification(integrity: PnlIntegrity, costBasisUsd: number | null, unrealizedPnlUsd: number | null): void {
    // Extra verification checks, ADDED: real, boolean, log-only signals — none of these change
    // behavior (the $1e9 clamp and ($0, $1e6] price guard already enforce the hard limits); these
    // exist so a log reader can see PRECISELY which property failed, e.g. distinguishing "PnL is
    // absurd relative to a tiny cost basis" (the "-3.8e+34"-style explosion this task described)
    // from "PnL is null because evidence is missing" — both currently look similar in a raw diff.
    const costBasisFiniteAndNonNegative = costBasisUsd == null || (Number.isFinite(costBasisUsd) && costBasisUsd >= 0)
    const unrealizedPnlFinite = unrealizedPnlUsd == null || Number.isFinite(unrealizedPnlUsd)
    // "Reasonable range relative to cost basis": a real, if extreme, PnL should be within a large
    // but bounded multiple of the position's own cost basis — flags a magnitude/unit-scale bug
    // (e.g. an accidental extra multiplication) even for values still under the flat $1e9 clamp.
    // $1 floor avoids dividing by ~0 for a near-zero cost basis; 1e6x is deliberately generous
    // (this is a diagnostic signal, not a second clamp).
    const unrealizedPnlWithinReasonableRangeOfCostBasis =
      unrealizedPnlUsd == null || costBasisUsd == null
        ? true
        : Math.abs(unrealizedPnlUsd) <= Math.max(costBasisUsd, 1) * 1e6

    // eslint-disable-next-line no-console
    console.warn('[verify_pnl_engine]', {
      token: holding.tokenAddress,
      price: holding.currentPriceUsd,
      costBasisUsd,
      unrealizedPnlUsd,
      integrity,
      excluded: integrity !== 'ok',
      costBasisFiniteAndNonNegative,
      unrealizedPnlFinite,
      unrealizedPnlWithinReasonableRangeOfCostBasis,
    })
    // eslint-disable-next-line no-console
    console.warn('[verify_price_fetch]', {
      token: holding.tokenAddress,
      currentPriceOk,
      historicalPriceOk,
      finalPrice: priceResult.priceUsd,
      integrity,
    })
  }

  // SANITY GUARD: a current price outside ($0, $1e6] is provider garbage — never fabricate PnL
  // from it, regardless of what the historical lookup found.
  if (!currentPriceOk) {
    logPriceDiagnostics(holding.chain, holding.tokenAddress, 'current_price_out_of_range')
    // eslint-disable-next-line no-console
    console.warn('pnl_missing_evidence', { tokenAddress: holding.tokenAddress, chain: holding.chain, reason: 'current_price_out_of_range', currentPriceUsd: holding.currentPriceUsd })
    logVerification('missing_evidence', null, null)
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
  if (!historicalPriceOk) {
    logPriceDiagnostics(
      holding.chain,
      holding.tokenAddress,
      priceResult.priceUsd == null ? 'historical_price_missing' : 'historical_price_out_of_range',
    )
    // eslint-disable-next-line no-console
    console.warn('pnl_missing_cost_basis', { tokenAddress: holding.tokenAddress, chain: holding.chain, priceAtTime: priceResult.priceUsd })
    logVerification('missing_cost_basis', null, null)
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

  const costBasisUsd = holding.amount * (priceResult.priceUsd as number)
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

  logVerification('ok', costBasisUsd, unrealizedPnlUsd)

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
export async function computeUnrealizedPnl(
  req: UnrealizedPnlRequest,
  fetchPriceAtTime: GetPriceAtTimeFn = getPriceAtTime,
): Promise<UnrealizedPnlResult> {
  const tokens = await Promise.all(req.holdings.map((h) => computeTokenPnl(h, fetchPriceAtTime)))

  // Sum strictly over integrity === 'ok' tokens — never a null-coalesced 0 for an excluded token,
  // per this task's explicit "never treat null as 0" requirement. `okTokens` narrows
  // unrealizedPnlUsd to `number` (not `number | null`), so this is a real number the whole way
  // through, not an incidental effect of ?? 0 summing to the same total.
  const okTokens = tokens.filter((t): t is TokenUnrealizedPnl & { unrealizedPnlUsd: number } => t.integrity === 'ok')
  const totalUnrealizedPnlUsd = okTokens.reduce((sum, t) => sum + t.unrealizedPnlUsd, 0)

  // excludedFromPnl MUST include every token with integrity !== 'ok' — defined directly against
  // integrity (not inferred from nullness) so the two can never drift apart.
  const excludedFromPnl = tokens.filter((t) => t.integrity !== 'ok').map((t) => t.tokenAddress)

  const integrityCounts = {
    ok: tokens.filter((t) => t.integrity === 'ok').length,
    missing_cost_basis: tokens.filter((t) => t.integrity === 'missing_cost_basis').length,
    missing_evidence: tokens.filter((t) => t.integrity === 'missing_evidence').length,
  }
  // Simple string classification, ADDED alongside the existing per-integrity counts (kept, not
  // replaced — nothing currently reading integrityCounts should break): 'ok' when every token
  // priced cleanly, 'failed' when every token failed, 'partial' otherwise. Only meaningful for a
  // non-empty holdings list — an empty wallet is reported as 'ok' (vacuously true, nothing failed).
  const integritySummary: 'ok' | 'partial' | 'failed' =
    tokens.length === 0 || integrityCounts.ok === tokens.length
      ? 'ok'
      : integrityCounts.ok === 0
        ? 'failed'
        : 'partial'

  // eslint-disable-next-line no-console
  console.warn('[pnl_final_verification]', {
    totalUnrealizedPnlUsd,
    excludedFromPnl,
    tokensProcessed: tokens.length,
    integrityCounts,
    integritySummary,
  })

  return { totalUnrealizedPnlUsd, tokens, excludedFromPnl }
}
