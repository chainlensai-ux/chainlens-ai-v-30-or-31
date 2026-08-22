// SOLANA CONFIDENCE SCORE, DISCLOSED (Token Scanner Solana premium-parity task; rebalanced
// following a real-scan report that the score read too high for a young, evidence-thin token).
//
// PURE PRESENTATION MAPPING, not a new scan: every input here is a field the Solana Beta scan
// result already carries (authority reads, top-account concentration, market/liquidity data,
// creator confidence, token age). No new provider call, no change to
// lib/server/solanaTokenScannerBeta.ts — this module reads its output, never re-derives it.
//
// REBALANCE, DISCLOSED — three real problems found across two rounds of live-scan reports:
//
// 1. "Evidence Coverage" was a CONSTANT, not a measurement, DISCLOSED: it scored
//    `25 - unsupportedChecks.length * 3`, but `unsupportedChecks` is the fixed, always-5-item list
//    of EVM-only checks (SOLANA_UNSUPPORTED_CHECKS) — identical for every single Solana scan
//    regardless of what evidence actually resolved. The category LOOKED like a per-scan read but
//    was mathematically the same number (10/25) every time. Fixed here: Evidence Coverage now
//    counts how many of THIS scan's own core signals actually resolved (authority read, market
//    data, holder concentration, metadata, deep creator check) — a real, scan-specific number.
//
// 2. NO CONCEPT OF CREATOR VERIFICATION OR TOKEN AGE, DISCLOSED: Authority + Concentration +
//    Market alone were worth 75 of 100 points, so a freshly-launched token with revoked
//    authorities and a healthy-looking pool could score in the mid-80s with zero verified facts
//    about who created it or how long it has traded — the same category of problem already fixed
//    in lib/solanaCortexRisk.ts's redesign (see that file's header for the fuller rationale).
//    Fixed here the same way: a new Track Record category (creator confidence + real pool age,
//    both already-gathered evidence) is now a genuine 20 of 100 points.
//
// 3. THE FIX FOR #2 ITSELF THEN CAUSED A NEW, WORSE PROBLEM, DISCLOSED: the first version of this
//    rebalance added hard clamps — an unverified creator OR a young/unresolved pool each capped
//    the total score at the SAME fixed ceiling (58). Deep Creator Check is opt-in and never runs
//    automatically (see deepCreatorAnalyzer.ts), so `creatorConfidence.tier === 'UNKNOWN'` is the
//    DEFAULT state on nearly every first-view scan — not an exceptional finding. Combined with most
//    freshly-scanned tokens also being young, nearly every scan hit one or both clamps and
//    collapsed onto the identical 58 ceiling: "every token reads the same score" was a direct,
//    reproducible consequence of that design, not a coincidence. Fixed here by replacing the fixed
//    clamps with a CONTINUOUS multiplier (creatorFactor × maturityFactor × evidenceFactor, each a
//    smooth function of the token's OWN real age/evidence/creator-tier, never a shared step
//    function) — two tokens both lacking a Deep Creator Check now land at genuinely different
//    scores whenever their age or evidence coverage genuinely differs, which is the common case.
//
// VERDICT VOCABULARY, DISCLOSED (reported live: "a lot of it is open check and not actual facts"):
// the top label used to be the literal string "Open Check", which reads as "we didn't check" — the
// exact opposite of what it means here, since the top band is reached only when the supported
// checks came back clean AND the token has real age and evidence behind it. It is now
// "Low Risk Signals", which states the actual finding (few risk signals in what was checked) and
// matches the CORTEX engine's own "Low Contract Risk" vocabulary so the two surfaces read
// consistently. The honesty ceiling is unchanged and unchanged in spirit: the best reachable label
// still never says "Safe"/"Strong"/"Verified", because this score is built from supported Solana
// evidence only.
//
// Client-safe: no env var read, no secret, importable from both the Token Scanner page component
// and this module's own test script.

import type { SolanaBetaScanResult } from './server/solanaTokenScannerBeta'

export type SolanaConfidenceCategory = { label: string; score: number; max: number; reasons: string[] }
export type SolanaConfidenceRead = {
  score: number
  /** Raw weighted score before the confidence multiplier — for transparency; `score` is the real, adjusted number. */
  uncappedScore: number
  /** Empty when the multiplier was effectively 1 (no meaningful discount applied). */
  scoreCapReasons: string[]
  verdict: 'Low Risk Signals' | 'Caution' | 'High Risk'
  color: string
  categories: SolanaConfidenceCategory[]
}

function fmtLargeUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'Unavailable'
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

const CATEGORY_MAX = 20

export function computeSolanaConfidenceScore(
  sr: Pick<SolanaBetaScanResult,
    | 'authorityReadSucceeded' | 'mintAuthority' | 'freezeAuthority' | 'topAccountConcentration'
    | 'marketDataAvailable' | 'marketData' | 'unsupportedChecks' | 'resolvedTokenName'
    | 'creatorConfidence' | 'deepCreator' | 'clusterMap'
  >,
): SolanaConfidenceRead {
  const authorityCat: SolanaConfidenceCategory = (() => {
    if (!sr.authorityReadSucceeded) return { label: 'Authority Safety', score: 5, max: CATEGORY_MAX, reasons: ['Authority read unavailable'] }
    if (!sr.mintAuthority && !sr.freezeAuthority) return { label: 'Authority Safety', score: CATEGORY_MAX, max: CATEGORY_MAX, reasons: ['Mint authority revoked', 'Freeze authority revoked'] }
    if (sr.mintAuthority && sr.freezeAuthority) return { label: 'Authority Safety', score: 1, max: CATEGORY_MAX, reasons: ['Mint authority active', 'Freeze authority active'] }
    return { label: 'Authority Safety', score: 9, max: CATEGORY_MAX, reasons: [sr.mintAuthority ? 'Mint authority active' : 'Freeze authority active'] }
  })()

  const conc = sr.topAccountConcentration
  const concentrationCat: SolanaConfidenceCategory = (() => {
    const t10 = conc?.top10Percent
    if (t10 == null) return { label: 'Concentration Safety', score: 6, max: CATEGORY_MAX, reasons: ['Top-account data unavailable'] }
    if (t10 < 30) return { label: 'Concentration Safety', score: CATEGORY_MAX, max: CATEGORY_MAX, reasons: [`Top 10 accounts hold ${t10.toFixed(1)}%`] }
    if (t10 < 50) return { label: 'Concentration Safety', score: 11, max: CATEGORY_MAX, reasons: [`Top 10 accounts hold ${t10.toFixed(1)}%`] }
    return { label: 'Concentration Safety', score: 3, max: CATEGORY_MAX, reasons: [`Top 10 accounts hold ${t10.toFixed(1)}%`] }
  })()

  const liq = sr.marketData?.liquidityUsd ?? null
  const marketCat: SolanaConfidenceCategory = (() => {
    if (!sr.marketDataAvailable) return { label: 'Market Health', score: 3, max: CATEGORY_MAX, reasons: ['No indexed pool found'] }
    if (liq == null) return { label: 'Market Health', score: 9, max: CATEGORY_MAX, reasons: ['Pool found — liquidity unverified'] }
    if (liq >= 50_000) return { label: 'Market Health', score: CATEGORY_MAX, max: CATEGORY_MAX, reasons: [`Liquidity ${fmtLargeUsd(liq)}`] }
    if (liq >= 5_000) return { label: 'Market Health', score: 13, max: CATEGORY_MAX, reasons: [`Liquidity ${fmtLargeUsd(liq)}`] }
    return { label: 'Market Health', score: 6, max: CATEGORY_MAX, reasons: [`Thin liquidity ${fmtLargeUsd(liq)}`] }
  })()

  // ── Track Record (NEW) — creator verification + real pool age, the category the previous
  // 4-category version entirely lacked. See this file's header, deviation #2. ────────────────────
  const trackRecordCat: SolanaConfidenceCategory = (() => {
    const cc = sr.creatorConfidence
    const days = sr.marketData?.pairAgeDays ?? null
    let score = 0
    const reasons: string[] = []
    if (cc.tier === 'CONFIRMED') { score += 11; reasons.push('Creator identity confirmed') }
    else if (cc.tier === 'LIKELY') { score += 8; reasons.push('Creator identity likely resolved') }
    else if (cc.tier === 'POSSIBLE') { score += 4; reasons.push('Creator identity possibly resolved') }
    else reasons.push('Creator identity unverified — Deep Creator Check not run')
    if (sr.clusterMap?.attempted && sr.clusterMap.riskLevel !== 'elevated' && sr.clusterMap.evidenceCount > 0) { score += 2; reasons.push('Deep Cluster Check found no elevated funding-pattern risk') }
    else if (sr.clusterMap?.attempted && sr.clusterMap.riskLevel === 'elevated') { reasons.push('Deep Cluster Check flagged elevated funding-pattern risk') }
    if (days == null) reasons.push('Pool age unresolved')
    else if (days < 3) { score += 1; reasons.push(`Pool is ${days < 1 ? 'under a day' : `${days} day(s)`} old`) }
    else if (days < 7) { score += 3; reasons.push(`Pool is ${days} days old`) }
    else if (days < 30) { score += 5; reasons.push(`Pool is ${days} days old`) }
    else { score += 7; reasons.push(`Pool is ${days} days old`) }
    return { label: 'Track Record', score: Math.min(CATEGORY_MAX, score), max: CATEGORY_MAX, reasons }
  })()

  // ── Evidence Coverage (FIXED) — a real, scan-specific measurement, not the previous constant.
  // See this file's header, deviation #1. ───────────────────────────────────────────────────────
  const evidenceCat: SolanaConfidenceCategory = (() => {
    const signals = [
      sr.authorityReadSucceeded,
      sr.marketDataAvailable,
      sr.topAccountConcentration != null,
      sr.resolvedTokenName != null,
      sr.deepCreator != null,
    ]
    const resolved = signals.filter(Boolean).length
    const score = Math.round((resolved / signals.length) * CATEGORY_MAX)
    return { label: 'Evidence Coverage', score, max: CATEGORY_MAX, reasons: [`${resolved} of ${signals.length} core signals resolved this scan`, `${sr.unsupportedChecks.length} EVM-only checks structurally unsupported on Solana`] }
  })()

  const categories = [authorityCat, concentrationCat, marketCat, trackRecordCat, evidenceCat]
  const uncappedScore = categories.reduce((sum, c) => sum + c.score, 0)

  // ── Confidence multiplier, DISCLOSED: replaces the previous fixed-clamp caps — see this file's
  // header, deviation #3, for exactly why a shared clamp value made most scans converge on the
  // same number. Each factor is a smooth, continuous function of THIS token's own real evidence
  // (age in days, evidence-signal fraction, creator tier), never a step function shared across
  // tokens, so the final score spreads naturally instead of piling onto one ceiling. ─────────────
  const capReasons: string[] = []
  const days = sr.marketData?.pairAgeDays ?? null

  const creatorFactor = sr.creatorConfidence.tier === 'CONFIRMED' ? 1
    : sr.creatorConfidence.tier === 'LIKELY' ? 0.97
    : sr.creatorConfidence.tier === 'POSSIBLE' ? 0.93
    : 0.88
  if (creatorFactor < 1) capReasons.push('Creator identity has not been verified (Deep Creator Check not run) — reduces the score proportionally, not to a fixed ceiling.')

  const maturityFactor = days == null ? 0.80
    : days >= 30 ? 1
    : days >= 7 ? 0.85 + ((days - 7) / 23) * 0.15
    : 0.65 + (days / 7) * 0.20
  if (maturityFactor < 0.98) capReasons.push(days == null ? 'Pool age could not be resolved — reduces the score proportionally.' : `Pool is only ${days < 1 ? 'under a day' : `${days} day(s)`} old — reduces the score proportionally the younger it is.`)

  const evidenceFraction = evidenceCat.max > 0 ? evidenceCat.score / evidenceCat.max : 0
  const evidenceFactor = 0.85 + evidenceFraction * 0.15
  if (evidenceFactor < 0.98) capReasons.push('Evidence coverage is limited for this scan — reduces the score proportionally.')

  const multiplier = creatorFactor * maturityFactor * evidenceFactor
  const score = Math.round(uncappedScore * multiplier)
  const activeCapReasons = multiplier < 0.97 ? capReasons : []

  const verdict: SolanaConfidenceRead['verdict'] = score >= 75 ? 'Low Risk Signals' : score >= 40 ? 'Caution' : 'High Risk'
  const color = verdict === 'Low Risk Signals' ? '#34d399' : verdict === 'Caution' ? '#fbbf24' : '#f87171'
  return { score, uncappedScore, scoreCapReasons: activeCapReasons, verdict, color, categories }
}
