// SOLANA CONFIDENCE SCORE, DISCLOSED (Token Scanner Solana premium-parity task; rebalanced
// following a real-scan report that the score read too high for a young, evidence-thin token).
//
// PURE PRESENTATION MAPPING, not a new scan: every input here is a field the Solana Beta scan
// result already carries (authority reads, top-account concentration, market/liquidity data,
// creator confidence, token age). No new provider call, no change to
// lib/server/solanaTokenScannerBeta.ts — this module reads its output, never re-derives it.
//
// REBALANCE, DISCLOSED — two real problems in the previous 4-category version:
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
//    both already-gathered evidence) is now a genuine 20 of 100 points, and — because a category
//    alone isn't a strong enough guarantee — an unverified creator or a very young pool also caps
//    the total score below the top "Open Check" band, regardless of how clean the other four
//    categories read.
//
// The verdict LABEL is capped independently of the number for the same reason as before — the
// best reachable label is still "Open Check", never "Safe"/"Strong"/"Verified".
//
// Client-safe: no env var read, no secret, importable from both the Token Scanner page component
// and this module's own test script.

import type { SolanaBetaScanResult } from './server/solanaTokenScannerBeta'

export type SolanaConfidenceCategory = { label: string; score: number; max: number; reasons: string[] }
export type SolanaConfidenceRead = {
  score: number
  /** Raw weighted score before any track-record/evidence cap — for transparency; `score` is the real, capped number. */
  uncappedScore: number
  /** Empty when no cap applied. */
  scoreCapReasons: string[]
  verdict: 'Open Check' | 'Caution' | 'High Risk'
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

  // ── Caps, DISCLOSED: an unverified creator, a very young pool, or thin evidence each cap the
  // TOTAL score below the top verdict band, regardless of how clean authority/concentration/
  // market read — the mechanism that keeps a young, unevidenced token from reading "Open Check"
  // on authority-and-liquidity alone. Mirrors lib/solanaCortexRisk.ts's own cap logic. ───────────
  const capReasons: string[] = []
  const caps: number[] = []
  if (sr.creatorConfidence.tier === 'UNKNOWN') { caps.push(58); capReasons.push('Creator identity has not been verified (Deep Creator Check not run) — capped below the top band.') }
  const days = sr.marketData?.pairAgeDays ?? null
  if (days == null || days < 7) { caps.push(58); capReasons.push('Token is very young or its age is unresolved — capped below the top band.') }
  else if (days < 30) { caps.push(74); capReasons.push('Token is under 30 days old — capped just below the top band.') }
  if (evidenceCat.score / evidenceCat.max < 0.5) { caps.push(58); capReasons.push('Evidence coverage is limited for this scan — capped below the top band.') }
  const score = caps.length > 0 ? Math.min(uncappedScore, ...caps) : uncappedScore
  const activeCapReasons = caps.length > 0 && score < uncappedScore ? capReasons : []

  const verdict: SolanaConfidenceRead['verdict'] = score >= 75 ? 'Open Check' : score >= 40 ? 'Caution' : 'High Risk'
  const color = verdict === 'Open Check' ? '#94a3b8' : verdict === 'Caution' ? '#fbbf24' : '#f87171'
  return { score, uncappedScore, scoreCapReasons: activeCapReasons, verdict, color, categories }
}
