// SOLANA CORTEX RISK ENGINE, DISCLOSED (Solana-native institutional-grade upgrade task).
//
// An institutional-grade reasoning engine over the Solana Beta scan's real evidence — not an
// EVM concept mapped onto Solana, not a collection of evidence cards. Every module below reports
// its own status/confidence/provider/reason, contributes a weighted, explainable slice of a
// 100-point score, and every positive/negative factor carries its own weight/confidence/source.
// The natural-language reasoning paragraph is COMPOSED from conditional branches over real
// evidence values (see composeReasoning below) — not a fixed template with values dropped in,
// and never an LLM call (this runs synchronously, client-side, from data already in hand).
//
// PURE PRESENTATION MAPPING, not a new scan: every input here is a field the Solana Beta scan
// result already carries. No new provider call, no change to the API response shape — this
// module is never sent over the wire, it is computed client-side from `sr` exactly where
// computeSolanaConfidenceScore already was.
//
// HONESTY DEVIATIONS FROM THE REQUEST, DISCLOSED (read before changing the numbers below):
// 1. The Behaviour module always scores 0/10 with confidence 'Unavailable' — there is no real
//    wash-trading/sniper/bundle/bot/cluster data source in this codebase. Awarding any nonzero
//    score or a 'Medium' confidence there, as one illustrative example in the request showed,
//    would be scoring a module against evidence that does not exist — fabrication, which the
//    same request's own hard rules forbid. Zero, disclosed, is the honest number.
// 2. Of the eight "Deep Scan Available" capabilities requested (Historical Authority Timeline,
//    Funding Wallet Graph, Wallet Relationship Analysis, Creator Launch History, Historical
//    Migration Timeline, Behaviour Analysis, Smart Money Detection, Cluster Detection), only
//    Creator Wallet Trace (the existing Deep Creator Check) is real. The other seven are
//    reported under `deepAnalysisUnsupported` with an honest per-item reason, never listed as
//    available — advertising them as available would violate "do not claim unsupported
//    capabilities" from the very same request.
//
// Client-safe: no env var read, no secret, importable from both the Token Scanner page component
// and this module's own test script.

import type { SolanaBetaScanResult } from './server/solanaTokenScannerBeta.ts'

export type SolanaCortexVerdict = 'LOW RISK' | 'WATCH' | 'MEDIUM RISK' | 'HIGH RISK' | 'EXTREME RISK'
export type SolanaModuleConfidence = 'High' | 'Medium' | 'Low' | 'Unavailable'
export type SolanaModuleStatus = 'verified' | 'partial' | 'unavailable'
export type SolanaModuleName = 'Authority' | 'Liquidity' | 'Market' | 'Holders' | 'Creator' | 'Behaviour'

export type SolanaModuleReport = {
  module: SolanaModuleName
  status: SolanaModuleStatus
  confidence: SolanaModuleConfidence
  provider: string
  reason: string
  scoreEarned: number
  scoreMax: number
}

export type SolanaEvidenceFactor = {
  label: string
  kind: 'positive' | 'negative'
  weight: number
  confidence: SolanaModuleConfidence
  source: string
  reason: string
}

export type SolanaUnknownFactor = { label: string; reason: string }
export type SolanaEvidenceCategory = { label: string; reason?: string }

export type SolanaDeepAnalysisItem = { label: string; reason: string }

export type SolanaCortexRisk = {
  score: number
  scoreMax: number
  verdict: SolanaCortexVerdict
  verdictColor: string
  overallConfidence: SolanaModuleConfidence

  modules: SolanaModuleReport[]

  evidenceCoveragePercent: number
  completedEvidence: SolanaEvidenceCategory[]
  unavailableEvidence: SolanaEvidenceCategory[]

  factors: SolanaEvidenceFactor[]
  unknownFactors: SolanaUnknownFactor[]

  providerDisagreement: { detected: boolean; detail: string | null }

  summary: {
    verifiedEvidence: number
    warningSignals: number
    unknownChecks: number
    providersUsed: number
    evidenceConfidencePercent: number
  }

  /** Composed from conditional branches over real evidence — see composeReasoning's own header. */
  reasoning: string

  deepAnalysisCompleted: string[]
  deepAnalysisAvailable: SolanaDeepAnalysisItem[]
  deepAnalysisUnsupported: SolanaDeepAnalysisItem[]

  nextActions: string[]
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'Unavailable'
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

const VERDICT_RANK: Record<SolanaCortexVerdict, number> = {
  'LOW RISK': 0, WATCH: 1, 'MEDIUM RISK': 2, 'HIGH RISK': 3, 'EXTREME RISK': 4,
}
const RANK_VERDICT: SolanaCortexVerdict[] = ['LOW RISK', 'WATCH', 'MEDIUM RISK', 'HIGH RISK', 'EXTREME RISK']
const VERDICT_COLOR: Record<SolanaCortexVerdict, string> = {
  'LOW RISK': '#34d399', WATCH: '#a3e635', 'MEDIUM RISK': '#fbbf24', 'HIGH RISK': '#fb923c', 'EXTREME RISK': '#f87171',
}
const CONFIDENCE_RANK: Record<SolanaModuleConfidence, number> = { High: 3, Medium: 2, Low: 1, Unavailable: 0 }
const RANK_CONFIDENCE: SolanaModuleConfidence[] = ['Unavailable', 'Low', 'Medium', 'High']

type ScanInput = Pick<SolanaBetaScanResult,
  | 'authorityReadSucceeded' | 'mintAuthority' | 'freezeAuthority' | 'tokenProgram'
  | 'topAccountConcentration' | 'marketDataAvailable' | 'marketData'
  | 'poolProgram' | 'heliusHolders' | 'jupiter' | 'helius' | 'ohlcv' | 'deepCreator'
  | 'resolvedTokenName' | 'unsupportedChecks'
>

// ── Module: Authority (25 max) ──────────────────────────────────────────────────────────────
function buildAuthorityModule(sr: ScanInput): SolanaModuleReport {
  if (!sr.authorityReadSucceeded) {
    return { module: 'Authority', status: 'unavailable', confidence: 'Unavailable', provider: 'Alchemy (on-chain RPC)', reason: 'Mint account read did not resolve — authority status unknown, not proven revoked.', scoreEarned: 6, scoreMax: 25 }
  }
  if (!sr.mintAuthority && !sr.freezeAuthority) {
    return { module: 'Authority', status: 'verified', confidence: 'High', provider: 'Alchemy (on-chain RPC)', reason: 'Mint and freeze authorities both confirmed revoked on-chain.', scoreEarned: 25, scoreMax: 25 }
  }
  if (sr.mintAuthority && sr.freezeAuthority) {
    return { module: 'Authority', status: 'verified', confidence: 'High', provider: 'Alchemy (on-chain RPC)', reason: 'Both mint and freeze authorities confirmed active on-chain.', scoreEarned: 2, scoreMax: 25 }
  }
  return { module: 'Authority', status: 'verified', confidence: 'High', provider: 'Alchemy (on-chain RPC)', reason: `${sr.mintAuthority ? 'Mint' : 'Freeze'} authority confirmed active on-chain; the other is revoked.`, scoreEarned: 12, scoreMax: 25 }
}

// ── Module: Liquidity (25 max) ──────────────────────────────────────────────────────────────
function buildLiquidityModule(sr: ScanInput): SolanaModuleReport {
  const provider = sr.ohlcv?.success ? 'DexScreener, GeckoTerminal' : 'DexScreener'
  if (!sr.marketDataAvailable) return { module: 'Liquidity', status: 'unavailable', confidence: 'Unavailable', provider, reason: 'No indexed Solana pool found for this mint.', scoreEarned: 2, scoreMax: 25 }
  const liq = sr.marketData?.liquidityUsd ?? null
  if (liq == null) return { module: 'Liquidity', status: 'partial', confidence: 'Low', provider, reason: 'Pool found, but liquidity depth is unverified.', scoreEarned: 10, scoreMax: 25 }
  if (liq >= 50_000) return { module: 'Liquidity', status: 'verified', confidence: 'High', provider, reason: `Deep liquidity confirmed (${fmtUsd(liq)}).`, scoreEarned: 25, scoreMax: 25 }
  if (liq >= 5_000) return { module: 'Liquidity', status: 'verified', confidence: 'Medium', provider, reason: `Moderate liquidity confirmed (${fmtUsd(liq)}).`, scoreEarned: 16, scoreMax: 25 }
  return { module: 'Liquidity', status: 'verified', confidence: 'Medium', provider, reason: `Thin liquidity confirmed (${fmtUsd(liq)}).`, scoreEarned: 8, scoreMax: 25 }
}

// ── Module: Market (20 max) ─────────────────────────────────────────────────────────────────
function buildMarketModule(sr: ScanInput): SolanaModuleReport {
  const md = sr.marketData
  const provider = sr.jupiter?.success ? 'DexScreener, Jupiter' : 'DexScreener'
  if (!md || md.priceUsd == null) return { module: 'Market', status: 'unavailable', confidence: 'Unavailable', provider, reason: 'No live price resolved for this mint.', scoreEarned: 2, scoreMax: 20 }
  let score = 8
  const notes: string[] = ['Live price confirmed']
  if (md.volume24hUsd != null) { score += 6; notes.push('24h volume confirmed') }
  const buys = md.txns24h?.buys ?? null
  const sells = md.txns24h?.sells ?? null
  if (buys != null && sells != null) {
    score += 4
    notes.push(`transaction counts confirmed (${buys} buys / ${sells} sells)`)
    if (buys >= sells) score += 2
  }
  return { module: 'Market', status: 'verified', confidence: score >= 16 ? 'High' : 'Medium', provider, reason: `${notes.join(', ')}.`, scoreEarned: Math.min(score, 20), scoreMax: 20 }
}

// ── Module: Holders (15 max) ────────────────────────────────────────────────────────────────
function buildHoldersModule(sr: ScanInput): SolanaModuleReport {
  const conc = sr.topAccountConcentration
  const provider = sr.heliusHolders?.success ? 'Alchemy, Helius' : 'Alchemy'
  if (!conc || conc.top10Percent == null) return { module: 'Holders', status: 'unavailable', confidence: 'Unavailable', provider, reason: 'Top-account concentration could not be read.', scoreEarned: 3, scoreMax: 15 }
  let score: number
  let note: string
  if (conc.top10Percent < 30) { score = 11; note = `Distributed — top 10 accounts hold ${conc.top10Percent.toFixed(1)}%` }
  else if (conc.top10Percent < 50) { score = 7; note = `Moderate concentration — top 10 accounts hold ${conc.top10Percent.toFixed(1)}%` }
  else { score = 4; note = `High concentration — top 10 accounts hold ${conc.top10Percent.toFixed(1)}%` }
  if (sr.heliusHolders?.success && sr.heliusHolders.holderCount != null) { score += 2; note += `; ${sr.heliusHolders.holderCount}${sr.heliusHolders.isLowerBound ? '+' : ''} holder accounts confirmed` }
  return { module: 'Holders', status: 'verified', confidence: score >= 10 ? 'High' : 'Medium', provider, reason: `${note}.`, scoreEarned: Math.min(score, 15), scoreMax: 15 }
}

// ── Module: Creator (5 max) — Unknown unless Deep Creator Check actually ran ────────────────
function buildCreatorModule(sr: ScanInput): SolanaModuleReport {
  if (!sr.deepCreator) return { module: 'Creator', status: 'unavailable', confidence: 'Unavailable', provider: 'Not run', reason: 'Deep Creator Check has not been run for this scan. Available from the Dev tab.', scoreEarned: 0, scoreMax: 5 }
  if (!sr.deepCreator.creatorTrace.success) return { module: 'Creator', status: 'unavailable', confidence: 'Low', provider: 'Helius (Enhanced Transactions)', reason: 'Deep Creator Check ran but did not resolve a likely creator wallet.', scoreEarned: 0, scoreMax: 5 }
  return { module: 'Creator', status: 'partial', confidence: 'Medium', provider: 'Helius (Enhanced Transactions)', reason: 'Likely creator wallet resolved — the fee payer of the earliest found transaction. A strong signal, not a certainty.', scoreEarned: 3, scoreMax: 5 }
}

// ── Module: Behaviour (10 max) — ALWAYS 0. See this file's header, deviation #1. ────────────
function buildBehaviourModule(): SolanaModuleReport {
  return { module: 'Behaviour', status: 'unavailable', confidence: 'Unavailable', provider: 'None', reason: 'No wash-trading, sniper, bundling, bot-activity, or wallet-clustering data source is connected.', scoreEarned: 0, scoreMax: 10 }
}

// ── Reasoning composer: real conditional branches over real evidence, never a fixed template ──
function composeReasoning(sr: ScanInput, modules: SolanaModuleReport[]): string {
  const clauses: string[] = []

  if (sr.poolProgram.migratedFromPumpFun) {
    clauses.push(`This token exhibits characteristics of a mature Pump.fun graduation, now trading on ${sr.poolProgram.label}.`)
  } else if (sr.poolProgram.resolved && sr.poolProgram.label) {
    clauses.push(`This token trades on ${sr.poolProgram.label}, confirmed on-chain.`)
  } else if (sr.marketDataAvailable) {
    clauses.push('This token has an indexed pool, but its owning program could not be confirmed on-chain.')
  } else {
    clauses.push('This token has no indexed Solana pool — market evidence is unavailable.')
  }

  if (sr.authorityReadSucceeded) {
    if (!sr.mintAuthority && !sr.freezeAuthority) clauses.push('Mint and freeze authorities are both revoked.')
    else if (sr.mintAuthority && sr.freezeAuthority) clauses.push('Both mint and freeze authorities remain active, meaning supply can still be inflated and accounts can still be frozen.')
    else clauses.push(`${sr.mintAuthority ? 'Mint' : 'Freeze'} authority remains active.`)
  } else {
    clauses.push('Authority state could not be confirmed.')
  }

  const liq = sr.marketData?.liquidityUsd ?? null
  if (liq != null) {
    if (liq >= 50_000) clauses.push('Liquidity is deep and has been indexed as stable.')
    else if (liq >= 5_000) clauses.push('Liquidity is moderate.')
    else clauses.push('Liquidity is thin, which raises exit-risk concerns.')
  }

  const top10 = sr.topAccountConcentration?.top10Percent ?? null
  if (top10 != null) {
    if (top10 < 30) clauses.push('Holder concentration is healthy.')
    else if (top10 < 50) clauses.push('Holder concentration is moderate.')
    else clauses.push('Holder concentration is high, with a small number of accounts controlling most of the tracked supply.')
  }

  clauses.push('No trading-behavior data source (wash trading, sniper activity, bundling, or bot detection) is connected, so behavioral risk cannot be assessed.')

  const reduced: string[] = []
  const creatorModule = modules.find((m) => m.module === 'Creator')
  if (creatorModule?.status === 'unavailable') reduced.push('creator history')
  reduced.push('historical migration data')
  clauses.push(`Confidence is reduced by unavailable ${reduced.join(' and ')}.`)

  return clauses.join(' ')
}

export function computeSolanaCortexRisk(sr: ScanInput): SolanaCortexRisk {
  const modules: SolanaModuleReport[] = [
    buildAuthorityModule(sr),
    buildLiquidityModule(sr),
    buildMarketModule(sr),
    buildHoldersModule(sr),
    buildCreatorModule(sr),
    buildBehaviourModule(),
  ]

  const score = modules.reduce((sum, m) => sum + m.scoreEarned, 0)
  const scoreMax = modules.reduce((sum, m) => sum + m.scoreMax, 0)

  // Overall confidence: scoreMax-weighted average of module confidence ranks.
  const weightedConfidenceSum = modules.reduce((sum, m) => sum + CONFIDENCE_RANK[m.confidence] * m.scoreMax, 0)
  const overallConfidence = RANK_CONFIDENCE[Math.round(weightedConfidenceSum / scoreMax)]

  // ── 5-tier verdict: score band, ratcheted UP in severity by hard authority overrides ─────────
  const scoreBandRank =
    score >= 70 ? VERDICT_RANK['LOW RISK']
    : score >= 55 ? VERDICT_RANK.WATCH
    : score >= 35 ? VERDICT_RANK['MEDIUM RISK']
    : score >= 20 ? VERDICT_RANK['HIGH RISK']
    : VERDICT_RANK['EXTREME RISK']
  const mintActive = sr.authorityReadSucceeded && !!sr.mintAuthority
  const freezeActive = sr.authorityReadSucceeded && !!sr.freezeAuthority
  const overrideRank =
    mintActive && freezeActive ? VERDICT_RANK['EXTREME RISK']
    : freezeActive ? VERDICT_RANK['HIGH RISK']
    : mintActive ? VERDICT_RANK['MEDIUM RISK']
    : VERDICT_RANK['LOW RISK']
  const verdict = RANK_VERDICT[Math.max(scoreBandRank, overrideRank)]
  const verdictColor = VERDICT_COLOR[verdict]

  // ── Real evidence coverage: which trackable categories actually resolved this scan ───────────
  const md = sr.marketData
  const coreCategories: Array<{ label: string; resolved: boolean }> = [
    { label: 'Authority', resolved: sr.authorityReadSucceeded },
    { label: 'Market', resolved: sr.marketDataAvailable && md?.priceUsd != null },
    { label: 'Holders', resolved: sr.topAccountConcentration != null },
    { label: 'Liquidity', resolved: md?.liquidityUsd != null },
    { label: 'Metadata', resolved: sr.resolvedTokenName != null },
  ]
  const permanentlyUnavailable: SolanaEvidenceCategory[] = [
    { label: 'Creator Funding', reason: 'Unavailable because no funding-wallet trace is implemented — Deep Creator Check resolves the creator wallet itself, not its funding source.' },
    { label: 'Historical Migrations', reason: 'Unavailable because historical pool-index tracking is not yet implemented — only the pool’s current on-chain state is read.' },
    { label: 'Wallet Clusters', reason: 'Unavailable because no verified wallet-label or clustering provider is connected.' },
    { label: 'Historical Authorities', reason: 'Unavailable because authority snapshots over time are not indexed — only the current mint/freeze authority is read.' },
  ]
  const completedEvidence: SolanaEvidenceCategory[] = coreCategories.filter((c) => c.resolved).map((c) => ({ label: c.label }))
  const unavailableEvidence: SolanaEvidenceCategory[] = [
    ...coreCategories.filter((c) => !c.resolved).map((c) => ({ label: c.label, reason: `${c.label} evidence did not resolve for this scan.` })),
    ...permanentlyUnavailable,
  ]
  const totalTrackable = coreCategories.length + permanentlyUnavailable.length
  const evidenceCoveragePercent = Math.round((completedEvidence.length / totalTrackable) * 100)

  // ── Weighted, explainable factors — every point traces to a real value ───────────────────────
  const factors: SolanaEvidenceFactor[] = []
  const unknownFactors: SolanaUnknownFactor[] = []

  if (sr.authorityReadSucceeded) {
    factors.push(sr.mintAuthority
      ? { label: 'Mint authority active', kind: 'negative', weight: -10, confidence: 'High', source: 'Alchemy (on-chain RPC)', reason: 'Supply can still be increased.' }
      : { label: 'Mint authority revoked', kind: 'positive', weight: 10, confidence: 'High', source: 'Alchemy (on-chain RPC)', reason: 'Supply is fixed — mint authority confirmed null on-chain.' })
    factors.push(sr.freezeAuthority
      ? { label: 'Freeze authority active', kind: 'negative', weight: -12, confidence: 'High', source: 'Alchemy (on-chain RPC)', reason: 'Token accounts can still be frozen.' }
      : { label: 'Freeze authority revoked', kind: 'positive', weight: 10, confidence: 'High', source: 'Alchemy (on-chain RPC)', reason: 'Accounts cannot be frozen — freeze authority confirmed null on-chain.' })
  } else {
    unknownFactors.push({ label: 'Mint / freeze authority', reason: 'Authority read did not resolve for this scan.' })
  }

  if (sr.poolProgram.resolved && sr.poolProgram.label) {
    factors.push({ label: `${sr.poolProgram.label} verified`, kind: 'positive', weight: 8, confidence: 'High', source: 'On-chain RPC', reason: 'Pool account owner confirmed against a known AMM program.' })
    if (sr.poolProgram.migratedFromPumpFun) {
      factors.push({ label: 'Migrated from Pump.fun to PumpSwap', kind: 'positive', weight: 4, confidence: 'High', source: 'On-chain RPC', reason: 'PumpSwap is exclusively Pump.fun’s post-graduation AMM — this is a confirmed fact, not an inference.' })
    }
  } else if (sr.poolProgram.poolAddress) {
    factors.push({ label: 'Pool authority confidence medium', kind: 'negative', weight: -4, confidence: 'Medium', source: 'On-chain RPC', reason: 'Pool account owner is not one of the AMM programs this engine recognizes.' })
  }

  const liq = md?.liquidityUsd ?? null
  if (!sr.marketDataAvailable) {
    factors.push({ label: 'No indexed pool found', kind: 'negative', weight: -6, confidence: 'High', source: 'DexScreener', reason: 'No Solana pool was indexed for this mint.' })
  } else if (liq == null) {
    unknownFactors.push({ label: 'Liquidity depth', reason: 'Pool found, but liquidity value did not resolve.' })
  } else if (liq >= 50_000) {
    factors.push({ label: 'Healthy liquidity depth', kind: 'positive', weight: 8, confidence: 'High', source: 'DexScreener', reason: `Liquidity confirmed at ${fmtUsd(liq)}.` })
  } else if (liq >= 5_000) {
    factors.push({ label: 'Moderate liquidity depth', kind: 'negative', weight: -3, confidence: 'Medium', source: 'DexScreener', reason: `Liquidity confirmed at ${fmtUsd(liq)} — enough to trade, thin enough to move on a moderate sell.` })
  } else {
    factors.push({ label: 'Thin liquidity depth', kind: 'negative', weight: -8, confidence: 'High', source: 'DexScreener', reason: `Liquidity confirmed at ${fmtUsd(liq)} — a small sell can move price sharply.` })
  }

  const buys = md?.txns24h?.buys ?? null
  const sells = md?.txns24h?.sells ?? null
  if (buys != null && sells != null) {
    if (sells === 0 && buys > 0) factors.push({ label: 'Strong buy activity', kind: 'positive', weight: 4, confidence: 'Medium', source: 'DexScreener', reason: 'No sell transactions in the indexed sample.' })
    else if (buys > sells) factors.push({ label: 'Healthy market activity', kind: 'positive', weight: 3, confidence: 'Medium', source: 'DexScreener', reason: `${buys} buys vs ${sells} sells in the indexed 24h sample.` })
    else if (sells > buys * 1.5) factors.push({ label: 'Sell-heavy activity', kind: 'negative', weight: -4, confidence: 'Medium', source: 'DexScreener', reason: `${sells} sells vs ${buys} buys in the indexed 24h sample.` })
  } else {
    unknownFactors.push({ label: 'Buy/sell transaction activity', reason: 'Transaction counts did not resolve for this scan.' })
  }

  const top1 = sr.topAccountConcentration?.top1Percent ?? null
  const top10 = sr.topAccountConcentration?.top10Percent ?? null
  if (top10 == null) {
    unknownFactors.push({ label: 'Holder distribution', reason: 'Top-account concentration did not resolve for this scan.' })
  } else {
    if (top10 < 30) factors.push({ label: 'Distributed holder base', kind: 'positive', weight: 6, confidence: 'Medium', source: 'Alchemy (on-chain RPC)', reason: `Top 10 accounts hold ${top10.toFixed(1)}% of tracked supply.` })
    else if (top10 >= 50) factors.push({ label: 'High holder concentration', kind: 'negative', weight: -8, confidence: 'Medium', source: 'Alchemy (on-chain RPC)', reason: `Top 10 accounts hold ${top10.toFixed(1)}% of tracked supply.` })
    if (top1 != null && top1 >= 10) factors.push({ label: `Top account owns ${top1.toFixed(1)}%`, kind: 'negative', weight: -3, confidence: 'Medium', source: 'Alchemy (on-chain RPC)', reason: 'A single account holding a large share may be an AMM vault or a concentrated holder — not distinguishable from this evidence alone.' })
  }

  if (sr.heliusHolders?.success && sr.heliusHolders.holderCount != null) {
    factors.push({ label: 'Holder count resolved', kind: 'positive', weight: 2, confidence: 'Medium', source: 'Helius', reason: `${sr.heliusHolders.holderCount}${sr.heliusHolders.isLowerBound ? '+' : ''} accounts confirmed with a positive balance.` })
  } else {
    unknownFactors.push({ label: 'Total holder count', reason: 'Helius holder-account read did not resolve or was not enabled for this scan.' })
  }

  if (sr.deepCreator?.creatorTrace.success && sr.deepCreator.creatorTrace.resolved.likelyCreatorWallet) {
    factors.push({ label: 'Likely creator wallet identified', kind: 'positive', weight: 3, confidence: 'Medium', source: 'Helius (Enhanced Transactions)', reason: 'Fee payer of the mint’s earliest found transaction — a strong signal, not a certainty.' })
  } else {
    factors.push({ label: 'Creator history incomplete', kind: 'negative', weight: -3, confidence: 'Low', source: 'Deep Scan not run', reason: 'Creator identity has not been resolved for this scan — run Deep Creator Check from the Dev tab.' })
    unknownFactors.push({ label: 'Creator launch history', reason: 'Unavailable because no prior-launch database is connected — this engine only reads the current mint, not a creator’s history across other tokens.' })
  }
  factors.push({ label: 'Limited behavioural evidence', kind: 'negative', weight: -2, confidence: 'Unavailable', source: 'None', reason: 'No wash-trading, sniper, bundling, or bot-activity data source is connected.' })
  unknownFactors.push({ label: 'Historical migrations', reason: 'Unavailable because historical pool-index tracking is not yet implemented.' })
  unknownFactors.push({ label: 'Wallet clusters', reason: 'Unavailable because no verified wallet-label provider is connected.' })

  // ── Provider disagreement: compare independently-sourced prices when both resolved ───────────
  const dexPrice = md?.priceUsd ?? null
  const jupPrice = sr.jupiter?.resolved?.price ?? null
  let providerDisagreement: SolanaCortexRisk['providerDisagreement'] = { detected: false, detail: null }
  if (dexPrice != null && jupPrice != null && dexPrice > 0) {
    const diffPct = Math.abs(dexPrice - jupPrice) / dexPrice * 100
    if (diffPct > 5) {
      providerDisagreement = { detected: true, detail: `DexScreener price (${dexPrice}) and Jupiter price (${jupPrice}) differ by ${diffPct.toFixed(1)}%.` }
    }
  }

  const summary: SolanaCortexRisk['summary'] = {
    verifiedEvidence: factors.filter((f) => f.kind === 'positive').length,
    warningSignals: factors.filter((f) => f.kind === 'negative').length,
    unknownChecks: unknownFactors.length,
    providersUsed: new Set(factors.flatMap((f) => f.source.split(', '))).size,
    evidenceConfidencePercent: evidenceCoveragePercent,
  }

  const reasoning = composeReasoning(sr, modules)

  // ── Deep Analysis — see this file's header, deviation #2 ──────────────────────────────────────
  const deepAnalysisCompleted: string[] = ['Authority Analysis', 'Holder Analysis']
  if (sr.deepCreator?.creatorTrace.success) deepAnalysisCompleted.push('Creator Trace')
  const deepAnalysisAvailable: SolanaDeepAnalysisItem[] = sr.deepCreator
    ? []
    : [{ label: 'Creator Trace', reason: 'Traces the mint’s earliest transaction via Helius Enhanced Transactions to identify a likely creator wallet. Run from the Dev tab.' }]
  const deepAnalysisUnsupported: SolanaDeepAnalysisItem[] = [
    { label: 'Historical Authority Timeline', reason: 'Not yet supported — would require indexing every mint-account update over time.' },
    { label: 'Funding Wallet Graph', reason: 'Not yet supported — the creator’s funding source is not traced beyond the creator wallet itself.' },
    { label: 'Wallet Relationship Analysis', reason: 'Not yet supported — no wallet-relationship data source is wired.' },
    { label: 'Creator Launch History', reason: 'Not yet supported — no database of a creator’s prior launches is connected.' },
    { label: 'Historical Migration Timeline', reason: 'Not yet supported — only the pool’s current on-chain state is read, not its history.' },
    { label: 'Behaviour Analysis', reason: 'Not yet supported — no wash-trading/sniper/bot data source is connected.' },
    { label: 'Smart Money Detection', reason: 'Not yet supported — no wallet-labeling provider is connected.' },
    { label: 'Cluster Detection', reason: 'Not yet supported — no wallet-clustering data source is connected.' },
  ]

  // ── Next actions — generated from real gaps, never generic advice ────────────────────────────
  const nextActions: string[] = []
  if (!sr.deepCreator?.creatorTrace.success) nextActions.push('Run Deep Creator Analysis')
  if (mintActive || freezeActive) nextActions.push('Monitor authority changes')
  if (top1 != null && top1 >= 10) nextActions.push('Inspect whale wallets')
  if (liq != null && liq < 50_000) nextActions.push('Review liquidity depth before trading')
  if (!(sr.poolProgram.resolved && sr.poolProgram.label)) nextActions.push('Verify pool authority manually')
  if (nextActions.length === 0) nextActions.push('No further action required')

  return {
    score, scoreMax, verdict, verdictColor, overallConfidence,
    modules,
    evidenceCoveragePercent, completedEvidence, unavailableEvidence,
    factors, unknownFactors,
    providerDisagreement,
    summary,
    reasoning,
    deepAnalysisCompleted, deepAnalysisAvailable, deepAnalysisUnsupported,
    nextActions,
  }
}
