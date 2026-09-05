// src/pipeline/walletConditionMessages.ts — dynamic, cause-aware "wallet condition" messages
// explaining PnL confidence, pricing coverage, and evidence quality.
//
// HONESTY CONTRACT, DISCLOSED: every message here describes WHAT the data shows, not WHO is at
// fault. A cause is only ever named when it's actually known:
//   - deadTokens / zeroLiquidityTokens: a real fact about the token's own market (no liquidity, no
//     active pool) — genuinely wallet/holdings-side, since it describes what the wallet holds.
//   - unindexedTokens / providerErrors: a real fact about DATA COVERAGE (a provider's index doesn't
//     have this token, or a provider call errored/rate-limited) — this is a coverage/provider-side
//     limitation, not a property of the wallet.
//   - suppressionSkipped: a real fact about THIS SCANNER'S OWN policy (dust suppression
//     intentionally skips pricing pure-airdrop, no-real-activity tokens to reduce wasted pricing
//     calls — see src/pipeline/index.ts's resolveDustSuppressionKeys) — genuinely scanner-side, a
//     deliberate trade-off, not a wallet defect.
// Never blames the scanner for something wallet-side, never blames the wallet for something
// scanner/provider-side. Where a section has no real trigger, it is omitted entirely rather than
// shown empty or with a fabricated value.
//
// INPUT CONTRACT, DISCLOSED: this module only FORMATS numbers it's given — it does not compute
// tokenCount/deadTokens/etc. itself. Several of the requested inputs (previousPnL, microcaps,
// lowLiquidityTokens, excludedTokens as a named list) are not currently tracked anywhere in this
// pipeline's real data model (confirmed by reading src/pipeline/index.ts and its recent
// dust-suppression/CU-estimator additions) — the type below marks them optional, and every section
// that depends on one either hides itself or falls back to the closest real, already-computed
// signal, rather than a caller being forced to invent a number to satisfy this type.

export type WalletConditionInput = {
  tokenCount: number
  deadTokens: number
  unindexedTokens: number
  zeroLiquidityTokens: number
  failedPricingAttempts: number
  fallbackAttempts: number
  providerErrors: number
  suppressionSkipped: number
  closedLots: number
  totalSells: number
  // Optional, DISCLOSED: not currently tracked anywhere in this pipeline. When omitted, section 5
  // ("why PnL changed") is simply hidden — never fabricated as "unchanged" or "changed".
  previousPnL?: number | null
  currentPnL?: number | null
  // Optional, DISCLOSED: not currently tracked. Section 7 falls back to zero (MODERATE posture)
  // when both are omitted, rather than inventing a risk signal.
  lowLiquidityTokens?: number
  microcaps?: number
  // Optional, DISCLOSED: not currently tracked as a named list anywhere in this pipeline (the real
  // dust-suppression mechanism tracks (chain, token) KEYS, not human-readable symbols). Section 9 is
  // hidden when omitted or empty, never populated with a placeholder.
  excludedTokens?: string[]
  // TRUTHFULNESS-FIX INPUTS, DISCLOSED (observability/public-evidence-truthfulness task — confirmed
  // bug #2): without these three signals, this module previously had no way to know that a scan's
  // "0 closed lots / 0 total sells" could mean "genuinely no sells ever" OR "Alchemy transaction
  // history was rate-limited/missing, so we don't actually know how many sells there were" — the two
  // are indistinguishable from closedLots/totalSells alone, and the old code silently treated both as
  // the former (reporting FULL evidence, 100% confidence). All three are optional and default to the
  // "no known issue" value so a caller that hasn't wired them yet gets identical behavior to before —
  // except for the zero-evaluated-lots rule below, which is a real, previously-proven bug fix that
  // applies unconditionally (see closedLots===0 handling), not gated on these optional inputs.
  publicPnlStatus?: 'ok' | 'limited_verified_sample' | 'unavailable'
  rateLimitDetected?: boolean
  transactionHistoryPartial?: boolean
}

export type WalletConditionSection = { id: string; text: string }

function round(n: number): number {
  return Math.round(n)
}

// WALLET HEALTH SCORE, DISCLOSED: the task specifies the trigger condition and message shape but
// not a scoring formula — there is no existing "wallet health score" concept anywhere in this
// codebase to reuse. Implemented as a simple, fully transparent, deterministic penalty scale (never
// a black-box/ML-style number) so it's auditable and adjustable: dead tokens cost the most (a
// confirmed, real market fact), unindexed tokens cost less (a coverage gap, not necessarily the
// token's fault), and a large token count adds a flat complexity penalty. Explicitly a heuristic,
// not a precise measurement — described as one via `description`, never asserted as a scientific
// score.
function computeHealthScore(input: WalletConditionInput): { score: number; description: string } {
  let score = 100
  score -= Math.min(40, input.deadTokens * 4)
  score -= Math.min(30, input.unindexedTokens * 3)
  score -= Math.min(10, input.tokenCount > 50 ? 10 : 0)
  score = Math.max(0, Math.min(100, round(score)))
  const description = score >= 80 ? 'Stable' : score >= 50 ? 'Fragmented' : 'Highly Fragmented'
  return { score, description }
}

// EVIDENCE-QUALITY TRUTH RULES, DISCLOSED (confirmed bug #2 — production: providerErrors: 2,
// partial provider status on both chains, 0 closed lots, publicPnlStatus unavailable, Alchemy
// transaction history missing; old output: FULL evidence / 100% confidence / FULL scan depth):
//   - zeroEvaluated: closedLots === 0. Previously, when totalSells was ALSO 0 (exactly the case
//     when transaction history never arrived), `closedLots < totalSells` was false, so section 3/10
//     took their "complete" branch and section 8's confidence formula fell back to a hardcoded 100 —
//     a scan that evaluated ZERO lots was reported as 100% confident. This can never be correct:
//     zero evaluated lots means zero evidence, never full confidence in it.
//   - coverageIssue: any of providerErrors > 0, rateLimitDetected, transactionHistoryPartial, or
//     publicPnlStatus === 'unavailable' — a real, independent reason the underlying data itself may
//     be incomplete, distinct from "some priced sells lacked evidence" (which closedLots < totalSells
//     already covers). A wallet can have closedLots === totalSells (every sell we KNOW ABOUT got
//     priced) while still not knowing about every real sell, if the provider fetch itself was
//     rate-limited/partial — that must never read as FULL.
function deriveEvidenceQuality(input: WalletConditionInput): {
  zeroEvaluated: boolean
  incompletePricing: boolean
  coverageIssue: boolean
  isFull: boolean
} {
  const zeroEvaluated = input.closedLots === 0
  const incompletePricing = input.closedLots < input.totalSells
  const coverageIssue = input.providerErrors > 0
    || input.rateLimitDetected === true
    || input.transactionHistoryPartial === true
    || input.publicPnlStatus === 'unavailable'
  const isFull = !zeroEvaluated && !incompletePricing && !coverageIssue
  return { zeroEvaluated, incompletePricing, coverageIssue, isFull }
}

// PURE — builds only the sections this wallet's real data actually triggers, in the task's own
// numbered order. Never throws: every division is guarded, every optional field defaults to a
// value that hides its dependent section rather than fabricating one.
export function buildWalletConditionMessages(input: WalletConditionInput): WalletConditionSection[] {
  const sections: WalletConditionSection[] = []
  const evidence = deriveEvidenceQuality(input)

  // 1. WALLET HEALTH SCORE
  if (input.tokenCount > 50 || input.deadTokens > 0 || input.unindexedTokens > 0) {
    const { score, description } = computeHealthScore(input)
    sections.push({ id: 'walletHealthScore', text: `Wallet Health: ${score}/100 — ${description}` })
  }

  // 2. WALLET ISSUES DETECTED
  const issueLines: string[] = []
  if (input.deadTokens > 0) issueLines.push(`${input.deadTokens} tokens have no liquidity or active markets.`)
  if (input.unindexedTokens > 0) issueLines.push(`${input.unindexedTokens} tokens lack metadata or pool indexing.`)
  if (input.zeroLiquidityTokens > 0) issueLines.push(`${input.zeroLiquidityTokens} tokens have zero liquidity.`)
  if (input.failedPricingAttempts > 0) issueLines.push(`${input.failedPricingAttempts} pricing attempts returned no data.`)
  if (input.fallbackAttempts > 0) issueLines.push(`${input.fallbackAttempts} fallback attempts were required.`)
  if (issueLines.length > 0) {
    sections.push({ id: 'walletIssuesDetected', text: issueLines.join(' ') })
  }

  // 3. PNL EVIDENCE LEVEL — truth rules, DISCLOSED: FULL requires zero coverage issues AND at
  // least one evaluated lot; zero evaluated lots is always "Insufficient evidence" (never FULL,
  // never a bare "LIMITED — 0 of 0" that reads as vacuously complete).
  if (evidence.isFull) {
    sections.push({ id: 'pnlEvidenceLevel', text: 'PnL Evidence Level: FULL — All priced sells had complete on-chain evidence.' })
  } else if (evidence.zeroEvaluated) {
    sections.push({
      id: 'pnlEvidenceLevel',
      text: `PnL Evidence Level: Insufficient evidence — 0 of ${input.totalSells} closed lots verified (0% coverage).`,
    })
  } else {
    // PNL-COVERAGE-RECOVERY-FIX-5, DISCLOSED (Wallet Scanner PnL coverage bottleneck task — bad UI
    // copy fix): the prior wording ("X of Y sells had verifiable pricing") read as a plain fraction
    // of sell EVENTS, but X (closedLots) and Y (totalSells) are actually "verified closed lots" over
    // "total sell attempts" — the same numerator/denominator confusion this task named explicitly
    // ("Never say '603 of 192 sells had verifiable pricing'"). Restated as an unambiguous "N of M
    // closed lots verified (P% coverage)" — same real numbers, no wording that implies sells and
    // lots are interchangeable or that the fraction could read as >100%.
    sections.push({
      id: 'pnlEvidenceLevel',
      text: `PnL Evidence Level: Limited coverage — ${input.closedLots} of ${input.totalSells} closed lots verified (${input.totalSells > 0 ? round((input.closedLots / input.totalSells) * 100) : 0}% coverage).`,
    })
  }

  // 4. EVIDENCE GAPS (CAUSE-AWARE) — each line only appears when its own real signal is present;
  // multiple can appear together, since these are independent, non-exclusive causes.
  const gapLines: string[] = []
  if (input.deadTokens > 0) gapLines.push('Some tokens could not be priced due to zero liquidity.')
  if (input.unindexedTokens > 0) gapLines.push('Some tokens could not be priced due to missing metadata or pool indexing.')
  if (input.providerErrors > 0) gapLines.push('Some pricing data was unavailable due to provider errors or rate limits.')
  if (input.suppressionSkipped > 0) gapLines.push('Some tokens were intentionally skipped due to dust suppression rules.')
  if (gapLines.length > 0) {
    sections.push({ id: 'evidenceGaps', text: gapLines.join(' ') })
  }

  // 5. WHY PNL CHANGED — hidden entirely if either PnL value is unknown (never fabricates
  // "unchanged"). WALLET-SIDE vs PROVIDER/SCANNER-SIDE split, DISCLOSED: deadTokens/
  // zeroLiquidityTokens describe a real fact about the token's own market (wallet/holdings-side);
  // unindexedTokens/providerErrors/suppressionSkipped describe data-coverage or this scanner's own
  // policy (provider/scanner-side) — see this file's own header for the full reasoning.
  if (input.previousPnL != null && input.currentPnL != null && input.previousPnL !== input.currentPnL) {
    const lines = ['PnL changed because the set of trades with complete pricing evidence changed.']
    const walletSideCauses: string[] = []
    if (input.deadTokens > 0) walletSideCauses.push(`${input.deadTokens} dead (no-liquidity) tokens`)
    if (input.zeroLiquidityTokens > 0) walletSideCauses.push(`${input.zeroLiquidityTokens} zero-liquidity tokens`)
    if (walletSideCauses.length > 0) lines.push(`Wallet-side: ${walletSideCauses.join(', ')}.`)

    const providerSideCauses: string[] = []
    if (input.unindexedTokens > 0) providerSideCauses.push(`${input.unindexedTokens} unindexed tokens`)
    if (input.providerErrors > 0) providerSideCauses.push(`${input.providerErrors} provider errors/rate limits`)
    if (input.suppressionSkipped > 0) providerSideCauses.push(`${input.suppressionSkipped} tokens skipped by dust-suppression rules`)
    if (providerSideCauses.length > 0) lines.push(`Scanner/provider-side: ${providerSideCauses.join(', ')}.`)

    sections.push({ id: 'whyPnlChanged', text: lines.join(' ') })
  }

  // 6. WALLET COMPLEXITY LEVEL
  sections.push({
    id: 'walletComplexityLevel',
    text: input.tokenCount > 50
      ? 'Complexity: HIGH — This wallet interacts with many low-liquidity or experimental tokens.'
      : 'Complexity: NORMAL.',
  })

  // 7. WALLET RISK POSTURE — lowLiquidityTokens/microcaps default to 0 (MODERATE) when not
  // supplied, rather than fabricating a risk signal this pipeline doesn't currently compute.
  const lowLiquidityTokens = input.lowLiquidityTokens ?? 0
  const microcaps = input.microcaps ?? 0
  sections.push({
    id: 'walletRiskPosture',
    text: lowLiquidityTokens > 0 || microcaps > 0
      ? 'Risk Posture: HIGH — This wallet trades volatile or low-liquidity assets.'
      : 'Risk Posture: MODERATE.',
  })

  // 8. PNL CONFIDENCE SCORE — truth rules, DISCLOSED (confirmed bug #2): zero evaluated lots is
  // ALWAYS 0% confidence, never the old vacuous-100% fallback for totalSells === 0 (that fallback is
  // exactly what let a rate-limited scan with zero real data report "100% confident"). A genuine
  // coverage issue (provider errors, rate limiting, partial transaction history, or publicPnlStatus
  // unavailable) caps confidence below the "high confidence" range even when every KNOWN sell got
  // priced — a 100% closedLots/totalSells ratio does not mean the wallet's true sell set is complete.
  let confidence = evidence.zeroEvaluated
    ? 0
    : input.totalSells > 0
      ? round((input.closedLots / input.totalSells) * 100)
      : 0
  if (evidence.coverageIssue) confidence = Math.min(confidence, 79)
  sections.push({ id: 'pnlConfidenceScore', text: `PnL Confidence: ${confidence}% — Based on available pricing evidence.` })

  // 9. TOKENS EXCLUDED FROM PNL
  if (input.excludedTokens && input.excludedTokens.length > 0) {
    sections.push({ id: 'tokensExcludedFromPnl', text: `Excluded from PnL: ${input.excludedTokens.join(', ')} — Missing pricing evidence.` })
  }

  // 10. SCAN DEPTH INDICATOR — same truth rules as section 3: partial transaction history or any
  // other coverage issue can never read as FULL, and zero evaluated lots gets its own distinct
  // "Insufficient evidence" wording rather than being folded into the generic "Limited coverage" one.
  if (evidence.isFull) {
    sections.push({ id: 'scanDepthIndicator', text: 'Scan Depth: FULL.' })
  } else if (evidence.zeroEvaluated) {
    sections.push({ id: 'scanDepthIndicator', text: 'Scan Depth: Insufficient evidence — 0 closed lots verified.' })
  } else {
    sections.push({ id: 'scanDepthIndicator', text: `Scan Depth: Limited coverage — Only ${input.closedLots} of ${input.totalSells} closed lots verified.` })
  }

  return sections
}
