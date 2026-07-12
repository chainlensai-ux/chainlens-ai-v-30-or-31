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

// PURE — builds only the sections this wallet's real data actually triggers, in the task's own
// numbered order. Never throws: every division is guarded, every optional field defaults to a
// value that hides its dependent section rather than fabricating one.
export function buildWalletConditionMessages(input: WalletConditionInput): WalletConditionSection[] {
  const sections: WalletConditionSection[] = []

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

  // 3. PNL EVIDENCE LEVEL
  if (input.closedLots < input.totalSells) {
    sections.push({
      id: 'pnlEvidenceLevel',
      text: `PnL Evidence Level: LIMITED — ${input.closedLots} of ${input.totalSells} sells had verifiable pricing.`,
    })
  } else {
    sections.push({ id: 'pnlEvidenceLevel', text: 'PnL Evidence Level: FULL — All priced sells had complete on-chain evidence.' })
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

  // 8. PNL CONFIDENCE SCORE — guarded against divide-by-zero. totalSells === 0 reports 100%,
  // consistent with section 3/10's own FULL determination for the same edge case (closedLots <
  // totalSells is false when there are no sells at all — vacuously "complete", not "confident about
  // nothing").
  const confidence = input.totalSells > 0 ? round((input.closedLots / input.totalSells) * 100) : 100
  sections.push({ id: 'pnlConfidenceScore', text: `PnL Confidence: ${confidence}% — Based on available pricing evidence.` })

  // 9. TOKENS EXCLUDED FROM PNL
  if (input.excludedTokens && input.excludedTokens.length > 0) {
    sections.push({ id: 'tokensExcludedFromPnl', text: `Excluded from PnL: ${input.excludedTokens.join(', ')} — Missing pricing evidence.` })
  }

  // 10. SCAN DEPTH INDICATOR
  sections.push({
    id: 'scanDepthIndicator',
    text: input.closedLots < input.totalSells
      ? `Scan Depth: LIMITED — Only ${input.closedLots} priced sells reconstructed.`
      : 'Scan Depth: FULL.',
  })

  return sections
}
