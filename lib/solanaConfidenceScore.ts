// SOLANA CONFIDENCE SCORE, DISCLOSED (Token Scanner Solana premium-parity task).
//
// PURE PRESENTATION MAPPING, not a new scan: every input here is a field the Solana Beta scan
// result already carries (authority reads, top-account concentration, market/liquidity data, the
// real unsupportedChecks count). No new provider call, no change to
// lib/server/solanaTokenScannerBeta.ts — this module reads its output, never re-derives it.
//
// WHY A CAPPED SCORE, NOT AN OMITTED ONE: an earlier pass deliberately showed no numeric score at
// all, to avoid overstating confidence — but that produced a broken-looking "— / 100" gauge and
// read as an unfinished page rather than an intentionally narrower product. This task explicitly
// permits the alternative: "compute a limited Solana confidence score from supported evidence
// only, clearly labeled." The four categories below are weighted 25 each (100 max in principle),
// but "Evidence Coverage" is HARD-CAPPED well below 25 by the number of real EVM-only checks this
// path cannot run (3 points off per unsupported check, floor 6) — so the composite score can never
// reach anywhere close to 100 while checks are missing, and a 0-evidence scan still floors near 0.
// This is the mechanism that keeps "never show SAFE from incomplete evidence" true even with a
// number on screen: the ceiling itself reflects the coverage gap, it isn't asserted separately.
// The verdict LABEL is capped independently of the number for the same reason — the best reachable
// label is "Open Check", never "Safe"/"Strong"/"Verified".
//
// Client-safe: no env var read, no secret, importable from both the Token Scanner page component
// and this module's own test script.

import type { SolanaBetaScanResult } from './server/solanaTokenScannerBeta'

export type SolanaConfidenceCategory = { label: string; score: number; max: number; reasons: string[] }
export type SolanaConfidenceRead = {
  score: number
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

export function computeSolanaConfidenceScore(
  sr: Pick<SolanaBetaScanResult, 'authorityReadSucceeded' | 'mintAuthority' | 'freezeAuthority' | 'topAccountConcentration' | 'marketDataAvailable' | 'marketData' | 'unsupportedChecks'>,
): SolanaConfidenceRead {
  const authorityCat: SolanaConfidenceCategory = (() => {
    if (!sr.authorityReadSucceeded) return { label: 'Authority Safety', score: 6, max: 25, reasons: ['Authority read unavailable'] }
    if (!sr.mintAuthority && !sr.freezeAuthority) return { label: 'Authority Safety', score: 25, max: 25, reasons: ['Mint authority revoked', 'Freeze authority revoked'] }
    if (sr.mintAuthority && sr.freezeAuthority) return { label: 'Authority Safety', score: 2, max: 25, reasons: ['Mint authority active', 'Freeze authority active'] }
    return { label: 'Authority Safety', score: 12, max: 25, reasons: [sr.mintAuthority ? 'Mint authority active' : 'Freeze authority active'] }
  })()

  const conc = sr.topAccountConcentration
  const concentrationCat: SolanaConfidenceCategory = (() => {
    const t10 = conc?.top10Percent
    if (t10 == null) return { label: 'Concentration Safety', score: 8, max: 25, reasons: ['Top-account data unavailable'] }
    if (t10 < 30) return { label: 'Concentration Safety', score: 25, max: 25, reasons: [`Top 10 accounts hold ${t10.toFixed(1)}%`] }
    if (t10 < 50) return { label: 'Concentration Safety', score: 14, max: 25, reasons: [`Top 10 accounts hold ${t10.toFixed(1)}%`] }
    return { label: 'Concentration Safety', score: 4, max: 25, reasons: [`Top 10 accounts hold ${t10.toFixed(1)}%`] }
  })()

  const liq = sr.marketData?.liquidityUsd ?? null
  const marketCat: SolanaConfidenceCategory = (() => {
    if (!sr.marketDataAvailable) return { label: 'Market Health', score: 4, max: 25, reasons: ['No indexed pool found'] }
    if (liq == null) return { label: 'Market Health', score: 12, max: 25, reasons: ['Pool found — liquidity unverified'] }
    if (liq >= 50_000) return { label: 'Market Health', score: 25, max: 25, reasons: [`Liquidity ${fmtLargeUsd(liq)}`] }
    if (liq >= 5_000) return { label: 'Market Health', score: 16, max: 25, reasons: [`Liquidity ${fmtLargeUsd(liq)}`] }
    return { label: 'Market Health', score: 8, max: 25, reasons: [`Thin liquidity ${fmtLargeUsd(liq)}`] }
  })()

  const evidenceCat: SolanaConfidenceCategory = {
    label: 'Evidence Coverage', score: Math.max(6, 25 - sr.unsupportedChecks.length * 3), max: 25,
    reasons: [`${sr.unsupportedChecks.length} EVM-only checks unsupported`],
  }

  const categories = [authorityCat, concentrationCat, marketCat, evidenceCat]
  const score = categories.reduce((sum, c) => sum + c.score, 0)
  const verdict: SolanaConfidenceRead['verdict'] = score >= 60 ? 'Open Check' : score >= 35 ? 'Caution' : 'High Risk'
  const color = verdict === 'Open Check' ? '#94a3b8' : verdict === 'Caution' ? '#fbbf24' : '#f87171'
  return { score, verdict, color, categories }
}
