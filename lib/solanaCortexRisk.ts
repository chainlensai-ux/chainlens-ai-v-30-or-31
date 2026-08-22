// SOLANA CORTEX RISK ENGINE, DISCLOSED (Security-vs-Investment-Risk redesign task).
//
// REDESIGN, DISCLOSED: this replaces the previous 6-module engine (Authority/Liquidity/Market/
// Holders/Creator/Behaviour, 25/25/20/15/5/10) with 9 weighted categories, for two concrete
// problems the previous design had:
//
// 1. AUTHORITY COULD DOMINATE THE SCORE, DISCLOSED: the old Authority module alone was worth 25 of
//    100 points, and a freshly-launched token with revoked mint/freeze authority (routine for a
//    Pump.fun bonding-curve token) plus ordinary liquidity/market signals could reach the 80s
//    without a single verified fact about its creator, its age, or its trading behaviour. Revoked
//    authorities are real, good evidence — about ONE thing: whether supply/accounts can be
//    manipulated at the protocol level. They say nothing about whether the token is an
//    established, low-speculation asset. Conflating those two questions into one number is the
//    bug. This redesign fixes it structurally, not with a patch: Contract Security (18) + Supply
//    Control (14) — the only two categories authority state feeds — sum to 32 of 100 max. Even a
//    perfect 32/32 on those two alone cannot reach the top verdict tier (see the banding below),
//    and every other category is scored independently of authority state.
//
// 2. NO CONCEPT OF TOKEN AGE OR EVIDENCE DEPTH, DISCLOSED: the old engine had no maturity signal at
//    all — a token minted an hour ago and one trading for a year could reach the same score. This
//    adds a real Token Maturity category (from DexScreener's pairCreatedAt, already-gathered
//    evidence, never a new call) and an Evidence Confidence category (how much of the full picture
//    actually resolved), AND applies both as a PROPORTIONAL REDUCTION of the overall score — see
//    applyMaturityAndEvidenceCaps below, including its disclosed regression note on why these are
//    continuous multipliers rather than the fixed ceilings the first version used. A token cannot
//    read as low-risk purely because its
//    authorities are clean; it must also be old enough, evidenced enough, and have at least a
//    plausible creator trace. This is the literal mechanism behind "cap immature meme coins
//    regardless of authority status."
//
// SECURITY VS INVESTMENT RISK, DISCLOSED: `securityRead` is a second, independently computed
// verdict built ONLY from Contract Security + Supply Control (can this contract be manipulated at
// the protocol level — mint inflation, freeze, malicious Token-2022 extensions). The main `verdict`
// (and `score`) is the full 9-category composite, capped by maturity/evidence/creator gates — this
// is what "Investment Risk" means here: a token can have a clean `securityRead` and still carry a
// speculative overall `verdict`, because youth, thin evidence, or unverified creator history are
// real risk even when the contract itself has no red flags. Neither field is ever "Safe"/
// "Verified" — the best reachable label on both is "Low Contract Risk", the same honesty ceiling
// this engine has always used.
//
// PURE PRESENTATION MAPPING, not a new scan: every input here is a field the Solana Beta scan
// result already carries — no new provider call, no change to the API response shape. Computed
// client-side from `sr`, same as before this redesign.
//
// HONESTY DEVIATIONS, DISCLOSED (unchanged from the previous version, read before changing the
// numbers below):
// 1. The Behaviour category never claims wash-trading/sniper/bundle/bot/cluster detection — there
//    is no real data source for any of that in this codebase. It is built ONLY from real buy/sell
//    transaction-count skew and a volume/liquidity churn ratio, both already-gathered DexScreener
//    evidence — never a fabricated behavioural score.
// 2. Of the eight "Deep Scan Available" capabilities the original spec named, only Creator Wallet
//    Trace (Deep Creator Check) and Cluster/Funding Trace (Deep Cluster Check) are real in this
//    codebase. The rest are reported under `deepAnalysisUnsupported` with an honest per-item
//    reason, never listed as available.
//
// Client-safe: no env var read, no secret, importable from both the Token Scanner page component
// and this module's own test script.

import type { SolanaBetaScanResult } from './server/solanaTokenScannerBeta.ts'

export type SolanaCortexVerdict = 'Low Contract Risk' | 'Speculative' | 'High Speculation' | 'High Risk' | 'Critical Risk'
export type SolanaModuleConfidence = 'High' | 'Medium' | 'Low' | 'Unavailable'
export type SolanaModuleStatus = 'verified' | 'partial' | 'unavailable'
export type SolanaModuleName =
  | 'Contract Security' | 'Supply Control' | 'Liquidity Quality' | 'Holder Distribution'
  | 'Creator/Cluster Intelligence' | 'Market Health' | 'Token Maturity' | 'Trading Behaviour' | 'Evidence Confidence'

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

/** A second, independent verdict built ONLY from contract-level security categories — see this file's header. */
export type SolanaSecurityRead = {
  score: number
  scoreMax: number
  percent: number
  verdict: SolanaCortexVerdict
  verdictColor: string
}

export type SolanaCortexRisk = {
  score: number
  scoreMax: number
  verdict: SolanaCortexVerdict
  verdictColor: string
  overallConfidence: SolanaModuleConfidence

  /** Contract-security-only read (Contract Security + Supply Control) — see this file's header. */
  securityRead: SolanaSecurityRead
  /** Raw weighted score before the maturity/evidence/creator scaling was applied — for transparency only; `score` above is the real, scaled number. */
  uncappedScore: number
  /** Empty when the scaling was negligible. Each entry names a gate that reduced the score and why — see applyMaturityAndEvidenceCaps. */
  scoreCapReasons: string[]

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
  'Low Contract Risk': 0, Speculative: 1, 'High Speculation': 2, 'High Risk': 3, 'Critical Risk': 4,
}
const RANK_VERDICT: SolanaCortexVerdict[] = ['Low Contract Risk', 'Speculative', 'High Speculation', 'High Risk', 'Critical Risk']
const VERDICT_COLOR: Record<SolanaCortexVerdict, string> = {
  'Low Contract Risk': '#34d399', Speculative: '#a3e635', 'High Speculation': '#fbbf24', 'High Risk': '#fb923c', 'Critical Risk': '#f87171',
}
const CONFIDENCE_RANK: Record<SolanaModuleConfidence, number> = { High: 3, Medium: 2, Low: 1, Unavailable: 0 }
const RANK_CONFIDENCE: SolanaModuleConfidence[] = ['Unavailable', 'Low', 'Medium', 'High']

/** score/scoreMax -> the same 5-tier ladder every verdict on this page uses, so a sub-score reads consistently with the overall one. */
function bandVerdict(score: number, scoreMax: number): SolanaCortexVerdict {
  const pct = scoreMax > 0 ? (score / scoreMax) * 100 : 0
  if (pct >= 78) return 'Low Contract Risk'
  if (pct >= 60) return 'Speculative'
  if (pct >= 40) return 'High Speculation'
  if (pct >= 22) return 'High Risk'
  return 'Critical Risk'
}

type ScanInput = Pick<SolanaBetaScanResult,
  | 'authorityReadSucceeded' | 'mintAuthority' | 'freezeAuthority' | 'tokenProgram'
  | 'topAccountConcentration' | 'marketDataAvailable' | 'marketData'
  | 'poolProgram' | 'heliusHolders' | 'jupiter' | 'helius' | 'ohlcv' | 'deepCreator'
  | 'resolvedTokenName' | 'unsupportedChecks' | 'supplyControl' | 'creatorConfidence' | 'clusterMap'
>

// ── EXTENSION RISK, DISCLOSED: severity classification of Token-2022 extensions, reused from
// the same real, parsed evidence supplyControlAnalyzer.ts/tokenExtensions.ts already produce — no
// new parsing here. Severe = can move/block/seize a holder's tokens without their consent
// (permanentDelegate, transferHook, nonTransferable) or hides evidence this engine relies on
// (confidentialTransferMint). Moderate = changes economics/behavior but isn't a seizure vector. ──
export const SOLANA_SEVERE_EXTENSIONS = new Set(['permanentDelegate', 'transferHook', 'nonTransferable', 'confidentialTransferMint'])
export const SOLANA_MODERATE_EXTENSIONS = new Set(['transferFeeConfig', 'defaultAccountState', 'mintCloseAuthority'])
const SEVERE_EXTENSIONS = SOLANA_SEVERE_EXTENSIONS
const MODERATE_EXTENSIONS = SOLANA_MODERATE_EXTENSIONS

/** Shared severity classification for a mint's real Token-2022 extensions — the exact same sets
 * Contract Security scoring uses, reused (not re-implemented) by the Supply Intelligence tab so
 * the two surfaces can never silently disagree on which extensions are risky. */
export function classifySolanaExtensionRisk(extensions: Array<{ type: string; label: string }>): {
  severe: Array<{ type: string; label: string }>
  moderate: Array<{ type: string; label: string }>
  benign: Array<{ type: string; label: string }>
} {
  return {
    severe: extensions.filter((e) => SOLANA_SEVERE_EXTENSIONS.has(e.type)),
    moderate: extensions.filter((e) => SOLANA_MODERATE_EXTENSIONS.has(e.type)),
    benign: extensions.filter((e) => !SOLANA_SEVERE_EXTENSIONS.has(e.type) && !SOLANA_MODERATE_EXTENSIONS.has(e.type)),
  }
}

// ── Category: Contract Security (18 max) — freeze authority + malicious Token-2022 extensions.
// Mint authority (inflation risk) is scored under Supply Control instead — see this file's header
// on why the two are kept separate rather than double-weighting the same fact. ──────────────────
function buildContractSecurityModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 18
  if (!sr.authorityReadSucceeded) {
    return { module: 'Contract Security', status: 'unavailable', confidence: 'Unavailable', provider: 'Alchemy (on-chain RPC)', reason: 'Mint account read did not resolve — freeze-authority status unknown, not proven revoked.', scoreEarned: 4, scoreMax: MAX }
  }
  let points = sr.freezeAuthority ? 4 : MAX
  const severeExt = sr.supplyControl.extensions.filter((e) => SEVERE_EXTENSIONS.has(e.type))
  const moderateExt = sr.supplyControl.extensions.filter((e) => MODERATE_EXTENSIONS.has(e.type))
  points -= severeExt.length * 6
  points -= moderateExt.length * 2
  points = Math.max(0, Math.min(MAX, points))
  const reasonParts: string[] = [sr.freezeAuthority ? 'Freeze authority is active — token accounts can be frozen at any time.' : 'Freeze authority confirmed revoked on-chain.']
  if (severeExt.length > 0) reasonParts.push(`${severeExt.length} severe Token-2022 extension(s) present (${severeExt.map((e) => e.label).join(', ')}) — can move or block tokens without holder consent.`)
  if (moderateExt.length > 0) reasonParts.push(`${moderateExt.length} moderate Token-2022 extension(s) present (${moderateExt.map((e) => e.label).join(', ')}).`)
  const confidence: SolanaModuleConfidence = sr.freezeAuthority || severeExt.length > 0 ? 'High' : 'High'
  return { module: 'Contract Security', status: 'verified', confidence, provider: 'Alchemy (on-chain RPC)', reason: reasonParts.join(' '), scoreEarned: points, scoreMax: MAX }
}

// ── Category: Supply Control (14 max) — mint authority / permanent-fixed-supply only. ───────────
function buildSupplyControlModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 14
  const sc = sr.supplyControl
  if (sc.supplyPermanentlyFixed == null) {
    return { module: 'Supply Control', status: 'unavailable', confidence: 'Unavailable', provider: 'Alchemy (on-chain RPC)', reason: sc.supplyFixedReason, scoreEarned: 3, scoreMax: MAX }
  }
  const points = sc.supplyPermanentlyFixed ? MAX : 2
  return { module: 'Supply Control', status: 'verified', confidence: 'High', provider: 'Alchemy (on-chain RPC)', reason: sc.supplyFixedReason, scoreEarned: points, scoreMax: MAX }
}

// ── Category: Liquidity Quality (14 max) — pool depth + verified AMM program identity. ──────────
function buildLiquidityQualityModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 14
  const provider = sr.ohlcv?.success ? 'DexScreener, GeckoTerminal' : 'DexScreener'
  if (!sr.marketDataAvailable) return { module: 'Liquidity Quality', status: 'unavailable', confidence: 'Unavailable', provider, reason: 'No indexed Solana pool found for this mint.', scoreEarned: 1, scoreMax: MAX }
  const liq = sr.marketData?.liquidityUsd ?? null
  let points: number
  let note: string
  if (liq == null) { points = 4; note = 'Pool found, but liquidity depth is unverified.' }
  else if (liq >= 50_000) { points = 12; note = `Deep liquidity confirmed (${fmtUsd(liq)}).` }
  else if (liq >= 5_000) { points = 8; note = `Moderate liquidity confirmed (${fmtUsd(liq)}).` }
  else { points = 4; note = `Thin liquidity confirmed (${fmtUsd(liq)}) — a small sell can move price sharply.` }
  if (sr.poolProgram.verdict === 'verified_official_pool') { points += 2; note += ` Pool owning program verified as ${sr.poolProgram.label}.` }
  points = Math.min(MAX, points)
  return { module: 'Liquidity Quality', status: 'verified', confidence: liq != null ? (liq >= 5_000 ? 'High' : 'Medium') : 'Low', provider, reason: note, scoreEarned: points, scoreMax: MAX }
}

// ── Category: Market Health (8 max) — is there an observable, currently-trading market. ─────────
function buildMarketHealthModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 8
  const md = sr.marketData
  const provider = sr.jupiter?.success ? 'DexScreener, Jupiter' : 'DexScreener'
  if (!md || md.priceUsd == null) return { module: 'Market Health', status: 'unavailable', confidence: 'Unavailable', provider, reason: 'No live price resolved for this mint.', scoreEarned: 1, scoreMax: MAX }
  let score = 4
  const notes: string[] = ['Live price confirmed']
  if (md.volume24hUsd != null) { score += 2; notes.push('24h volume confirmed') }
  const buys = md.txns24h?.buys ?? null
  const sells = md.txns24h?.sells ?? null
  if (buys != null && sells != null) { score += 2; notes.push(`transaction counts confirmed (${buys} buys / ${sells} sells)`) }
  return { module: 'Market Health', status: 'verified', confidence: score >= 6 ? 'High' : 'Medium', provider, reason: `${notes.join(', ')}.`, scoreEarned: Math.min(score, MAX), scoreMax: MAX }
}

// ── Category: Trading Behaviour (6 max) — buy/sell skew + volume/liquidity churn, DISCLOSED as
// the only real signals this engine has; wash-trading/sniper/bot detection is NOT claimed here. ──
function buildTradingBehaviourModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 6
  const md = sr.marketData
  const buys = md?.txns24h?.buys ?? null
  const sells = md?.txns24h?.sells ?? null
  const liq = md?.liquidityUsd ?? null
  const vol = md?.volume24hUsd ?? null
  if (buys == null || sells == null) {
    return { module: 'Trading Behaviour', status: 'unavailable', confidence: 'Unavailable', provider: 'DexScreener', reason: 'No wash-trading/sniper/bot detection is available in this engine — buy/sell transaction counts also did not resolve for this scan.', scoreEarned: 3, scoreMax: MAX }
  }
  let score = 3
  const notes: string[] = [`${buys} buys vs ${sells} sells in the indexed 24h sample`]
  if (sells > buys * 1.5) { score -= 2; notes.push('sell-heavy activity') }
  else if (buys >= sells) { score += 1; notes.push('buy-side activity holding up') }
  if (liq != null && liq > 0 && vol != null) {
    const churn = vol / liq
    if (churn > 10) { score -= 2; notes.push(`very high volume/liquidity churn (${churn.toFixed(1)}x) — a hallmark of highly speculative, fast-turnover trading`) }
    else if (churn > 3) { score -= 1; notes.push(`elevated volume/liquidity churn (${churn.toFixed(1)}x)`) }
    else if (churn < 0.2) { score -= 1; notes.push(`very low volume/liquidity churn (${churn.toFixed(2)}x) — market may be largely inactive`) }
  }
  score = Math.max(0, Math.min(MAX, score))
  return { module: 'Trading Behaviour', status: 'partial', confidence: 'Medium', provider: 'DexScreener', reason: `${notes.join(', ')}. No wash-trading, sniper, bundling, or bot-activity data source is connected — this category reflects transaction-count and churn signals only.`, scoreEarned: score, scoreMax: MAX }
}

// ── Category: Holder Distribution (12 max). ───────────────────────────────────────────────────
function buildHolderDistributionModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 12
  const conc = sr.topAccountConcentration
  const provider = sr.heliusHolders?.success ? 'Alchemy, Helius' : 'Alchemy'
  if (!conc || conc.top10Percent == null) return { module: 'Holder Distribution', status: 'unavailable', confidence: 'Unavailable', provider, reason: 'Top-account concentration could not be read.', scoreEarned: 3, scoreMax: MAX }
  let score: number
  let note: string
  if (conc.top10Percent < 30) { score = 12; note = `Distributed — top 10 accounts hold ${conc.top10Percent.toFixed(1)}%` }
  else if (conc.top10Percent < 50) { score = 7; note = `Moderate concentration — top 10 accounts hold ${conc.top10Percent.toFixed(1)}%` }
  else { score = 3; note = `High concentration — top 10 accounts hold ${conc.top10Percent.toFixed(1)}%` }
  if (sr.heliusHolders?.success && sr.heliusHolders.holderCount != null) {
    note += `; ${sr.heliusHolders.holderCount}${sr.heliusHolders.isLowerBound ? '+' : ''} holder accounts confirmed`
    if (sr.heliusHolders.holderCount < 50) score = Math.max(0, score - 2)
  }
  return { module: 'Holder Distribution', status: 'verified', confidence: score >= 9 ? 'High' : 'Medium', provider, reason: `${note}.`, scoreEarned: Math.min(score, MAX), scoreMax: MAX }
}

// ── Category: Creator/Cluster Intelligence (10 max) — Confirmed/Likely/Possible/Unknown tier
// (Deep Creator Check), adjusted by Deep Cluster Check's real risk read when that also ran. ─────
function buildCreatorClusterModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 10
  const cc = sr.creatorConfidence
  if (cc.tier === 'UNKNOWN') return { module: 'Creator/Cluster Intelligence', status: 'unavailable', confidence: 'Unavailable', provider: 'Not run', reason: 'Deep Creator Check has not been run for this scan — creator identity is unverified. Available from the Dev tab.', scoreEarned: 1, scoreMax: MAX }
  let score = cc.tier === 'CONFIRMED' ? 8 : cc.tier === 'LIKELY' ? 6 : 3
  const notes: string[] = [`${cc.tier} — ${cc.reason}`]
  if (sr.clusterMap?.attempted) {
    if (sr.clusterMap.riskLevel === 'elevated') { score -= 2; notes.push(`Deep Cluster Check flagged elevated risk: ${sr.clusterMap.riskReason}`) }
    else if (sr.clusterMap.evidenceCount > 0) { score += 2; notes.push('Deep Cluster Check ran and found no elevated-risk funding pattern.') }
  }
  score = Math.max(0, Math.min(MAX, score))
  return { module: 'Creator/Cluster Intelligence', status: 'partial', confidence: cc.tier === 'CONFIRMED' ? 'High' : cc.tier === 'LIKELY' ? 'Medium' : 'Low', provider: 'Helius (Enhanced Transactions)', reason: notes.join(' '), scoreEarned: score, scoreMax: MAX }
}

// ── Category: Token Maturity (10 max) — real pool age from DexScreener's pairCreatedAt, already
// gathered by marketAnalyzer.ts. The category the previous engine entirely lacked. ──────────────
function buildTokenMaturityModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 10
  const days = sr.marketData?.pairAgeDays ?? null
  if (days == null) return { module: 'Token Maturity', status: 'unavailable', confidence: 'Unavailable', provider: 'DexScreener', reason: 'Pool creation time could not be resolved — token age is unknown, not assumed mature.', scoreEarned: 2, scoreMax: MAX }
  let score: number
  let tier: string
  if (days < 1) { score = 1; tier = 'less than a day old' }
  else if (days < 3) { score = 3; tier = `${days} day(s) old` }
  else if (days < 7) { score = 5; tier = `${days} days old` }
  else if (days < 30) { score = 7; tier = `${days} days old` }
  else if (days < 90) { score = 9; tier = `${days} days old` }
  else { score = MAX; tier = `${days} days old` }
  return { module: 'Token Maturity', status: 'verified', confidence: 'High', provider: 'DexScreener', reason: `Primary pool is ${tier}.`, scoreEarned: score, scoreMax: MAX }
}

// ── Category: Evidence Confidence (8 max) — how much of the full picture actually resolved,
// independent of whether the news is good or bad. ────────────────────────────────────────────
function buildEvidenceConfidenceModule(sr: ScanInput): SolanaModuleReport {
  const MAX = 8
  const signals = [
    sr.authorityReadSucceeded,
    sr.marketDataAvailable,
    sr.topAccountConcentration != null,
    !!sr.heliusHolders?.success,
    sr.resolvedTokenName != null,
    sr.deepCreator != null,
  ]
  const resolved = signals.filter(Boolean).length
  const score = Math.round((resolved / signals.length) * MAX)
  return { module: 'Evidence Confidence', status: resolved === signals.length ? 'verified' : resolved > 0 ? 'partial' : 'unavailable', confidence: resolved >= 5 ? 'High' : resolved >= 3 ? 'Medium' : 'Low', provider: 'Composite of every provider used this scan', reason: `${resolved} of ${signals.length} core evidence signals resolved for this scan (${sr.unsupportedChecks.length} EVM-only checks are structurally unsupported on Solana, not counted against this).`, scoreEarned: score, scoreMax: MAX }
}

// ── Reasoning composer: real conditional branches over real evidence, never a fixed template ──
function composeReasoning(sr: ScanInput, modules: SolanaModuleReport[], capReasons: string[]): string {
  const clauses: string[] = []
  const authorityM = modules.find((m) => m.module === 'Contract Security')!
  const supplyM = modules.find((m) => m.module === 'Supply Control')!
  const maturityM = modules.find((m) => m.module === 'Token Maturity')!
  const creatorM = modules.find((m) => m.module === 'Creator/Cluster Intelligence')!

  clauses.push(`Contract Security scores ${authorityM.scoreEarned}/${authorityM.scoreMax}: ${authorityM.reason}`)
  clauses.push(`Supply Control scores ${supplyM.scoreEarned}/${supplyM.scoreMax}: ${supplyM.reason}`)
  clauses.push(`Token Maturity scores ${maturityM.scoreEarned}/${maturityM.scoreMax}: ${maturityM.reason}`)
  clauses.push(`Creator/Cluster Intelligence scores ${creatorM.scoreEarned}/${creatorM.scoreMax}: ${creatorM.reason}`)

  if (capReasons.length > 0) {
    clauses.push(`The overall score is scaled down regardless of the categories above: ${capReasons.join(' ')}`)
  }
  clauses.push('No trading-behavior data source (wash trading, sniper activity, bundling, or bot detection) is connected, so behavioral risk beyond transaction-count skew cannot be assessed.')

  return clauses.join(' ')
}

// ── Maturity/evidence/creator SCALING, DISCLOSED: applied to the raw weighted score BEFORE verdict
// banding — the literal mechanism behind "cap immature meme coins regardless of authority status."
// A token cannot reach the top tier on clean authorities alone; it must also be old enough,
// evidenced enough, and have at least a plausible creator trace.
//
// REGRESSION FIXED, DISCLOSED (reported live: "SOLANA CORTEX RISK ENGINE · INVESTMENT RISK always
// the same"): this function previously imposed FIXED ceilings — Math.min(rawScore, 58/62/68/70/78/
// 82). Two of those trigger on almost every real scan: `creatorConfidence.tier === 'UNKNOWN'` is
// the DEFAULT state (Deep Creator Check is opt-in and never runs automatically) and pinned the
// score to exactly 70, and a pool under a day old pinned it to exactly 58. Because a ceiling
// DISCARDS the raw score entirely, every token that tripped the same ceiling landed on the SAME
// number no matter how differently its nine categories actually scored — the engine stopped
// discriminating precisely where it mattered. This is the identical bug already fixed in
// lib/solanaConfidenceScore.ts, and it is fixed the same structural way here: each gate now
// contributes a CONTINUOUS MULTIPLIER (< 1) instead of a fixed ceiling, so the raw category score
// is scaled down proportionally and two tokens differing in ANY category still differ in the final
// score. The severity ordering of the old ceilings is preserved in the multiplier magnitudes (an
// unresolved/under-a-day token is still penalised hardest), so "immature meme coins are capped
// regardless of authority status" remains true — it is now a proportional cap, not a shared one. ──
function applyMaturityAndEvidenceCaps(rawScore: number, modules: SolanaModuleReport[], creatorConfidence: ScanInput['creatorConfidence']): { score: number; reasons: string[] } {
  const reasons: string[] = []
  const maturityM = modules.find((m) => m.module === 'Token Maturity')!
  const evidenceM = modules.find((m) => m.module === 'Evidence Confidence')!

  // Maturity: scales continuously with the real, already-scored pool age rather than snapping to
  // one of three ceilings — a 2-day-old and a 6-day-old token no longer land on the same number.
  const maturityFraction = maturityM.scoreMax > 0 ? maturityM.scoreEarned / maturityM.scoreMax : 0
  let maturityFactor: number
  if (maturityM.status === 'unavailable' || maturityM.scoreEarned <= 1) {
    maturityFactor = 0.62
    reasons.push('Token age is unresolved or under a day — scales the score down sharply, proportionally to the rest of the evidence.')
  } else if (maturityFraction < 0.5) {
    maturityFactor = 0.72 + (maturityFraction / 0.5) * 0.10
    reasons.push('Token is under 7 days old — scales the score down until more trading history accumulates.')
  } else if (maturityFraction < 0.7) {
    maturityFactor = 0.86 + ((maturityFraction - 0.5) / 0.2) * 0.08
    reasons.push('Token is under 30 days old — scales the score down slightly.')
  } else {
    maturityFactor = 0.94 + ((maturityFraction - 0.7) / 0.3) * 0.06
  }

  // Evidence coverage: proportional to how much of the picture actually resolved.
  const evidenceFraction = evidenceM.scoreMax > 0 ? evidenceM.scoreEarned / evidenceM.scoreMax : 0
  const evidenceFactor = 0.80 + evidenceFraction * 0.20
  if (evidenceFraction < 0.5) reasons.push('Evidence coverage is limited — scales the score down until more checks resolve.')

  // Creator identity: UNKNOWN is the DEFAULT (Deep Creator Check is opt-in), so this must never be
  // a shared ceiling — it is the single largest contributor to the convergence bug above.
  const creatorFactor =
    creatorConfidence.tier === 'CONFIRMED' ? 1
    : creatorConfidence.tier === 'LIKELY' ? 0.97
    : creatorConfidence.tier === 'POSSIBLE' ? 0.92
    : 0.86
  if (creatorConfidence.tier === 'UNKNOWN') reasons.push('Creator identity has not been verified (Deep Creator Check not run) — scales the score down proportionally, not to a fixed ceiling.')
  else if (creatorConfidence.tier === 'POSSIBLE') reasons.push('Creator identity is only possibly resolved (signature history did not reach genesis) — scales the score down slightly.')

  const multiplier = maturityFactor * evidenceFactor * creatorFactor
  const score = Math.round(rawScore * multiplier)
  // Below ~3% total reduction the scaling is not materially changing the read — don't clutter the
  // UI with "why is this capped" copy the user cannot act on.
  return { score, reasons: multiplier < 0.97 ? reasons : [] }
}

export function computeSolanaCortexRisk(sr: ScanInput): SolanaCortexRisk {
  const modules: SolanaModuleReport[] = [
    buildContractSecurityModule(sr),
    buildSupplyControlModule(sr),
    buildLiquidityQualityModule(sr),
    buildHolderDistributionModule(sr),
    buildCreatorClusterModule(sr),
    buildMarketHealthModule(sr),
    buildTokenMaturityModule(sr),
    buildTradingBehaviourModule(sr),
    buildEvidenceConfidenceModule(sr),
  ]

  const uncappedScore = modules.reduce((sum, m) => sum + m.scoreEarned, 0)
  const scoreMax = modules.reduce((sum, m) => sum + m.scoreMax, 0)

  const { score, reasons: scoreCapReasons } = applyMaturityAndEvidenceCaps(uncappedScore, modules, sr.creatorConfidence)

  // Overall confidence: scoreMax-weighted average of module confidence ranks.
  const weightedConfidenceSum = modules.reduce((sum, m) => sum + CONFIDENCE_RANK[m.confidence] * m.scoreMax, 0)
  const overallConfidence = RANK_CONFIDENCE[Math.round(weightedConfidenceSum / scoreMax)]

  // ── Verdict: score band (on the CAPPED score), ratcheted UP in severity by hard authority
  // overrides — an active freeze or mint+freeze authority is real, on-chain risk that must never
  // read as better than its own severity regardless of how the rest of the categories scored. ────
  const scoreBandRank = VERDICT_RANK[bandVerdict(score, scoreMax)]
  const mintActive = sr.authorityReadSucceeded && !!sr.mintAuthority
  const freezeActive = sr.authorityReadSucceeded && !!sr.freezeAuthority
  const overrideRank =
    mintActive && freezeActive ? VERDICT_RANK['Critical Risk']
    : freezeActive ? VERDICT_RANK['High Risk']
    : mintActive ? VERDICT_RANK['High Speculation']
    : VERDICT_RANK['Low Contract Risk']
  const verdict = RANK_VERDICT[Math.max(scoreBandRank, overrideRank)]
  const verdictColor = VERDICT_COLOR[verdict]

  // ── Security read: Contract Security + Supply Control only — see this file's header. ──────────
  const securityModules = modules.filter((m) => m.module === 'Contract Security' || m.module === 'Supply Control')
  const securityScore = securityModules.reduce((s, m) => s + m.scoreEarned, 0)
  const securityScoreMax = securityModules.reduce((s, m) => s + m.scoreMax, 0)
  const securityBandRank = VERDICT_RANK[bandVerdict(securityScore, securityScoreMax)]
  const securityVerdict = RANK_VERDICT[Math.max(securityBandRank, overrideRank)]
  const securityRead: SolanaSecurityRead = {
    score: securityScore, scoreMax: securityScoreMax,
    percent: securityScoreMax > 0 ? Math.round((securityScore / securityScoreMax) * 100) : 0,
    verdict: securityVerdict, verdictColor: VERDICT_COLOR[securityVerdict],
  }

  // ── Real evidence coverage: which trackable categories actually resolved this scan ───────────
  const md = sr.marketData
  const coreCategories: Array<{ label: string; resolved: boolean }> = [
    { label: 'Authority', resolved: sr.authorityReadSucceeded },
    { label: 'Market', resolved: sr.marketDataAvailable && md?.priceUsd != null },
    { label: 'Holders', resolved: sr.topAccountConcentration != null },
    { label: 'Liquidity', resolved: md?.liquidityUsd != null },
    { label: 'Metadata', resolved: sr.resolvedTokenName != null },
    { label: 'Token Age', resolved: md?.pairAgeDays != null },
  ]
  const permanentlyUnavailable: SolanaEvidenceCategory[] = [
    { label: 'Wallet Clusters (cross-mint)', reason: 'Unavailable because no verified wallet-label or cross-mint clustering provider is connected.' },
    { label: 'Historical Migrations', reason: 'Unavailable because historical pool-index tracking is not yet implemented — only the pool’s current on-chain state is read.' },
    { label: 'Historical Authorities', reason: 'Unavailable because authority snapshots over time are not indexed — only the current mint/freeze authority is read.' },
    { label: 'Wash-Trading / Bot Detection', reason: 'Unavailable — no per-trade historical indexing is connected; only live transaction-count skew is used.' },
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

  const severeExt = sr.supplyControl.extensions.filter((e) => SEVERE_EXTENSIONS.has(e.type))
  for (const ext of severeExt) {
    factors.push({ label: `${ext.label} extension active`, kind: 'negative', weight: -8, confidence: 'High', source: 'Alchemy (on-chain RPC, jsonParsed)', reason: 'A Token-2022 extension that can move, block, or hide token activity without holder consent.' })
  }

  if (sr.poolProgram.resolved && sr.poolProgram.label) {
    factors.push({ label: `${sr.poolProgram.label} verified`, kind: 'positive', weight: 6, confidence: 'High', source: 'On-chain RPC', reason: 'Pool account owner confirmed against a known AMM program.' })
    if (sr.poolProgram.migratedFromPumpFun) {
      factors.push({ label: 'Migrated from Pump.fun to PumpSwap', kind: 'positive', weight: 3, confidence: 'High', source: 'On-chain RPC', reason: 'PumpSwap is exclusively Pump.fun’s post-graduation AMM — this is a confirmed fact, not an inference.' })
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
    factors.push({ label: 'Healthy liquidity depth', kind: 'positive', weight: 7, confidence: 'High', source: 'DexScreener', reason: `Liquidity confirmed at ${fmtUsd(liq)}.` })
  } else if (liq >= 5_000) {
    factors.push({ label: 'Moderate liquidity depth', kind: 'negative', weight: -3, confidence: 'Medium', source: 'DexScreener', reason: `Liquidity confirmed at ${fmtUsd(liq)} — enough to trade, thin enough to move on a moderate sell.` })
  } else {
    factors.push({ label: 'Thin liquidity depth', kind: 'negative', weight: -7, confidence: 'High', source: 'DexScreener', reason: `Liquidity confirmed at ${fmtUsd(liq)} — a small sell can move price sharply.` })
  }

  const pairAgeDays = md?.pairAgeDays ?? null
  if (pairAgeDays == null) {
    unknownFactors.push({ label: 'Token age', reason: 'Pool creation time could not be resolved for this scan.' })
  } else if (pairAgeDays < 3) {
    factors.push({ label: 'Very young token', kind: 'negative', weight: -9, confidence: 'High', source: 'DexScreener', reason: `Primary pool is only ${pairAgeDays < 1 ? 'under a day' : `${pairAgeDays} day(s)`} old — immature tokens carry elevated speculative risk regardless of contract state.` })
  } else if (pairAgeDays < 30) {
    factors.push({ label: 'Young token', kind: 'negative', weight: -4, confidence: 'Medium', source: 'DexScreener', reason: `Primary pool is ${pairAgeDays} days old.` })
  } else {
    factors.push({ label: 'Established trading history', kind: 'positive', weight: 5, confidence: 'High', source: 'DexScreener', reason: `Primary pool is ${pairAgeDays} days old.` })
  }

  const buys = md?.txns24h?.buys ?? null
  const sells = md?.txns24h?.sells ?? null
  if (buys != null && sells != null) {
    const vol = md?.volume24hUsd ?? null
    const churn = liq != null && liq > 0 && vol != null ? vol / liq : null
    if (churn != null && churn > 10) factors.push({ label: 'Very high volume/liquidity churn', kind: 'negative', weight: -5, confidence: 'Medium', source: 'DexScreener', reason: `${churn.toFixed(1)}x 24h volume vs liquidity — a hallmark of fast-turnover, highly speculative trading.` })
    else if (sells === 0 && buys > 0) factors.push({ label: 'Strong buy activity', kind: 'positive', weight: 3, confidence: 'Medium', source: 'DexScreener', reason: 'No sell transactions in the indexed sample.' })
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
    if (top10 < 30) factors.push({ label: 'Distributed holder base', kind: 'positive', weight: 5, confidence: 'Medium', source: 'Alchemy (on-chain RPC)', reason: `Top 10 accounts hold ${top10.toFixed(1)}% of tracked supply.` })
    else if (top10 >= 50) factors.push({ label: 'High holder concentration', kind: 'negative', weight: -7, confidence: 'Medium', source: 'Alchemy (on-chain RPC)', reason: `Top 10 accounts hold ${top10.toFixed(1)}% of tracked supply.` })
    if (top1 != null && top1 >= 10) factors.push({ label: `Top account owns ${top1.toFixed(1)}%`, kind: 'negative', weight: -3, confidence: 'Medium', source: 'Alchemy (on-chain RPC)', reason: 'A single account holding a large share may be an AMM vault or a concentrated holder — not distinguishable from this evidence alone.' })
  }

  if (sr.heliusHolders?.success && sr.heliusHolders.holderCount != null) {
    factors.push({ label: 'Holder count resolved', kind: 'positive', weight: 2, confidence: 'Medium', source: 'Helius', reason: `${sr.heliusHolders.holderCount}${sr.heliusHolders.isLowerBound ? '+' : ''} accounts confirmed with a positive balance.` })
    if (sr.heliusHolders.holderCount < 50) factors.push({ label: 'Very few holder accounts', kind: 'negative', weight: -3, confidence: 'Medium', source: 'Helius', reason: `Only ${sr.heliusHolders.holderCount}${sr.heliusHolders.isLowerBound ? '+' : ''} accounts hold a positive balance.` })
  } else {
    unknownFactors.push({ label: 'Total holder count', reason: 'Helius holder-account read did not resolve or was not enabled for this scan.' })
  }

  if (sr.creatorConfidence.tier === 'CONFIRMED') {
    factors.push({ label: 'Creator identity confirmed', kind: 'positive', weight: 4, confidence: 'High', source: 'Helius (Enhanced Transactions)', reason: sr.creatorConfidence.reason })
  } else if (sr.creatorConfidence.tier === 'LIKELY' || sr.creatorConfidence.tier === 'POSSIBLE') {
    factors.push({ label: 'Creator identity partially resolved', kind: 'negative', weight: -2, confidence: 'Low', source: 'Helius (Enhanced Transactions)', reason: sr.creatorConfidence.reason })
  } else {
    factors.push({ label: 'Creator history unverified', kind: 'negative', weight: -4, confidence: 'Unavailable', source: 'Deep Scan not run', reason: 'Creator identity has not been resolved for this scan — run Deep Creator Check from the Dev tab.' })
    unknownFactors.push({ label: 'Creator launch history', reason: 'Unavailable because no prior-launch database is connected — this engine only reads the current mint, not a creator’s history across other tokens.' })
  }
  if (sr.clusterMap?.attempted && sr.clusterMap.riskLevel === 'elevated') {
    factors.push({ label: 'Elevated funding-pattern risk', kind: 'negative', weight: -5, confidence: 'Medium', source: 'Helius (Enhanced Transactions)', reason: sr.clusterMap.riskReason })
  }
  unknownFactors.push({ label: 'Historical migrations', reason: 'Unavailable because historical pool-index tracking is not yet implemented.' })
  unknownFactors.push({ label: 'Wallet clusters (cross-mint)', reason: 'Unavailable because no verified cross-mint wallet-clustering provider is connected.' })

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

  const reasoning = composeReasoning(sr, modules, scoreCapReasons)

  // ── Deep Analysis — see this file's header, deviation #2 ──────────────────────────────────────
  const deepAnalysisCompleted: string[] = ['Contract Security Analysis', 'Holder Distribution Analysis']
  if (sr.deepCreator?.creatorTrace.success) deepAnalysisCompleted.push('Creator Trace')
  if (sr.clusterMap?.attempted) deepAnalysisCompleted.push('Cluster/Funding Trace')
  const deepAnalysisAvailable: SolanaDeepAnalysisItem[] = []
  if (!sr.deepCreator) deepAnalysisAvailable.push({ label: 'Creator Trace', reason: 'Traces the mint’s earliest transaction via Helius Enhanced Transactions to identify a likely creator wallet. Run from the Dev tab.' })
  if (!sr.clusterMap?.attempted) deepAnalysisAvailable.push({ label: 'Cluster/Funding Trace', reason: 'Traces who funded the likely creator wallet, plus mint/freeze-authority and LP-pool relationships. Run from the Cluster Map tab.' })
  const deepAnalysisUnsupported: SolanaDeepAnalysisItem[] = [
    { label: 'Historical Authority Timeline', reason: 'Not yet supported — would require indexing every mint-account update over time.' },
    { label: 'Wallet Relationship Analysis (cross-mint)', reason: 'Not yet supported — no cross-mint wallet-relationship data source is wired.' },
    { label: 'Creator Launch History', reason: 'Not yet supported — no database of a creator’s prior launches is connected.' },
    { label: 'Historical Migration Timeline', reason: 'Not yet supported — only the pool’s current on-chain state is read, not its history.' },
    { label: 'Wash-Trading / Bot / Bundle Detection', reason: 'Not yet supported — no per-trade historical indexing is connected.' },
    { label: 'Smart Money Detection', reason: 'Not yet supported — no wallet-labeling provider is connected.' },
  ]

  // ── Next actions — generated from real gaps, never generic advice ────────────────────────────
  const nextActions: string[] = []
  if (sr.creatorConfidence.tier === 'UNKNOWN') nextActions.push('Run Deep Creator Analysis')
  else if (!sr.clusterMap?.attempted) nextActions.push('Run Deep Cluster Check')
  if (mintActive || freezeActive) nextActions.push('Monitor authority changes')
  if (severeExt.length > 0) nextActions.push('Review Token-2022 extension risk in Supply Intelligence')
  if (top1 != null && top1 >= 10) nextActions.push('Inspect whale wallets')
  if (liq != null && liq < 50_000) nextActions.push('Review liquidity depth before trading')
  if (pairAgeDays != null && pairAgeDays < 7) nextActions.push('Treat as immature — position size accordingly')
  if (!(sr.poolProgram.resolved && sr.poolProgram.label)) nextActions.push('Verify pool authority manually')
  if (nextActions.length === 0) nextActions.push('No further action required')

  return {
    score, scoreMax, verdict, verdictColor, overallConfidence,
    securityRead, uncappedScore, scoreCapReasons,
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
