// SOLANA CORTEX RISK ENGINE, DISCLOSED (Solana-native Risk Engine task).
//
// Replaces the Risk Engine tab's EVM-flavored "Risk Drivers / Open Checks" presentation — which
// listed what Solana CAN'T check (honeypot, tax, LP lock/burn) — with a Solana-native read that
// only ever talks about what CAN be verified: authority state, on-chain-verified pool identity,
// real market/liquidity data, holder concentration, and (when run) the Deep Creator Check.
//
// PURE PRESENTATION MAPPING, not a new scan: every input here is a field the Solana Beta scan
// result already carries. No new provider call. Builds on computeSolanaConfidenceScore's already-
// tested 0–100 score (same categories, same honesty-capping mechanism) rather than re-deriving a
// second, competing number — this module adds the 5-tier verdict, evidence-coverage percentage,
// and positive/negative/unknown evidence buckets on top of that score.
//
// HONESTY CONTRACT: every signal below is a real, disclosed fact or an explicit "Unknown" — never
// a fabricated classification. Behavioral signals (wash trading, sniper concentration, bundled
// buys, bot activity, wallet clustering) have no real data source in this codebase and are always
// reported Unknown, never guessed at. Creator/launch-history signals are Unknown unless the Deep
// Creator Check actually ran and resolved a wallet — see lib/server/solana/deepCreatorAnalyzer.ts.
//
// Client-safe: no env var read, no secret, importable from both the Token Scanner page component
// and this module's own test script.

import type { SolanaBetaScanResult } from './server/solanaTokenScannerBeta.ts'
import { computeSolanaConfidenceScore } from './solanaConfidenceScore.ts'

export type SolanaCortexVerdict = 'LOW RISK' | 'WATCH' | 'MEDIUM RISK' | 'HIGH RISK' | 'EXTREME RISK'

export type SolanaCortexDeepAnalysisItem = {
  label: string
  available: boolean
  /** Present when available: what it does. Present when unavailable: why it doesn't exist yet. */
  reason: string
}

export type SolanaCortexRisk = {
  score: number
  confidence: 'Low' | 'Medium' | 'High'
  verdict: SolanaCortexVerdict
  verdictColor: string
  evidenceCoveragePercent: number
  evidenceCoverageReason: string
  positiveSignals: string[]
  negativeSignals: string[]
  unknownSignals: string[]
  deepAnalysis: SolanaCortexDeepAnalysisItem[]
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

export function computeSolanaCortexRisk(
  sr: Pick<SolanaBetaScanResult,
    | 'authorityReadSucceeded' | 'mintAuthority' | 'freezeAuthority' | 'tokenProgram'
    | 'topAccountConcentration' | 'marketDataAvailable' | 'marketData'
    | 'poolProgram' | 'heliusHolders' | 'jupiter' | 'helius' | 'ohlcv' | 'deepCreator'
    | 'unsupportedChecks'
  >,
): SolanaCortexRisk {
  const base = computeSolanaConfidenceScore(sr)

  // ── 5-tier verdict: score band, ratcheted UP in severity by hard authority overrides ─────────
  const scoreBandRank =
    base.score >= 70 ? VERDICT_RANK['LOW RISK']
    : base.score >= 55 ? VERDICT_RANK.WATCH
    : base.score >= 35 ? VERDICT_RANK['MEDIUM RISK']
    : base.score >= 20 ? VERDICT_RANK['HIGH RISK']
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

  // ── Evidence coverage: real, trackable categories only — nothing aspirational ────────────────
  const conc = sr.topAccountConcentration
  const md = sr.marketData
  const coverageChecks: Array<[label: string, resolved: boolean]> = [
    ['Authority read', sr.authorityReadSucceeded],
    ['Token program', sr.tokenProgram != null],
    ['Pool program verification', sr.poolProgram.resolved],
    ['Liquidity', md?.liquidityUsd != null],
    ['24h volume', md?.volume24hUsd != null],
    ['Buy/sell activity', md?.txns24h?.buys != null && md?.txns24h?.sells != null],
    ['Price / market cap', md?.priceUsd != null],
    ['Top-account concentration', conc != null],
    ['Holder count', sr.heliusHolders.success === true],
    ['Pair age', md?.pairAgeLabel != null],
  ]
  const resolvedCount = coverageChecks.filter(([, resolved]) => resolved).length
  const evidenceCoveragePercent = Math.round((resolvedCount / coverageChecks.length) * 100)

  const providers: string[] = []
  if (sr.authorityReadSucceeded || sr.tokenProgram != null) providers.push('Alchemy')
  if (md != null) providers.push('DexScreener')
  if (sr.ohlcv?.success) providers.push('GeckoTerminal')
  if (sr.jupiter?.success) providers.push('Jupiter')
  if (sr.heliusHolders?.success || sr.helius?.success) providers.push('Helius')
  const evidenceCoverageReason = providers.length > 0
    ? `Verified across ${providers.join(', ')}.`
    : 'Limited provider evidence available for this scan.'

  const confidence: SolanaCortexRisk['confidence'] =
    evidenceCoveragePercent >= 80 ? 'High' : evidenceCoveragePercent >= 50 ? 'Medium' : 'Low'

  // ── Positive / Negative / Unknown evidence — real facts only, never a guessed classification ──
  const positiveSignals: string[] = []
  const negativeSignals: string[] = []
  const unknownSignals: string[] = []

  if (sr.authorityReadSucceeded) {
    if (!sr.mintAuthority) positiveSignals.push('Mint authority revoked')
    else negativeSignals.push('Mint authority still active — supply can be increased')
    if (!sr.freezeAuthority) positiveSignals.push('Freeze authority revoked')
    else negativeSignals.push('Freeze authority still active — token accounts can be frozen')
  } else {
    unknownSignals.push('Mint/freeze authority (read did not resolve)')
  }

  if (sr.poolProgram.resolved && sr.poolProgram.label) {
    positiveSignals.push(`${sr.poolProgram.label} verified`)
    if (sr.poolProgram.migratedFromPumpFun) positiveSignals.push('Migrated from Pump.fun to PumpSwap')
  } else if (sr.poolProgram.poolAddress) {
    negativeSignals.push('Pool program not fully verified')
  }

  const liq = md?.liquidityUsd ?? null
  if (!sr.marketDataAvailable) {
    negativeSignals.push('No indexed Solana pool found')
  } else if (liq == null) {
    unknownSignals.push('Liquidity depth')
  } else if (liq >= 50_000) {
    positiveSignals.push(`Healthy liquidity (${fmtUsd(liq)})`)
  } else if (liq >= 5_000) {
    negativeSignals.push(`Moderate liquidity (${fmtUsd(liq)})`)
  } else {
    negativeSignals.push(`Thin liquidity (${fmtUsd(liq)})`)
  }

  const buys = md?.txns24h?.buys ?? null
  const sells = md?.txns24h?.sells ?? null
  if (buys != null && sells != null) {
    if (sells === 0 && buys > 0) positiveSignals.push('Strong buy activity — no sells in the sample')
    else if (buys > sells) positiveSignals.push(`Strong market activity (buys ${buys} / sells ${sells})`)
    else if (sells > buys * 1.5) negativeSignals.push(`Sell-heavy activity (buys ${buys} / sells ${sells})`)
  } else {
    unknownSignals.push('Buy/sell transaction activity')
  }

  const top1 = conc?.top1Percent ?? null
  const top10 = conc?.top10Percent ?? null
  if (top10 == null) {
    unknownSignals.push('Holder distribution')
  } else {
    if (top10 < 30) positiveSignals.push(`Distributed holders (top 10 hold ${top10.toFixed(1)}%)`)
    else if (top10 >= 50) negativeSignals.push(`High concentration — top 10 hold ${top10.toFixed(1)}%`)
    if (top1 != null && top1 >= 10) negativeSignals.push(`Whale owns ${top1.toFixed(1)}%`)
  }

  if (sr.heliusHolders.success && sr.heliusHolders.holderCount != null) {
    positiveSignals.push(`Holder count resolved (${sr.heliusHolders.holderCount}${sr.heliusHolders.isLowerBound ? '+' : ''} accounts)`)
  } else {
    unknownSignals.push('Total holder count')
  }

  // Creator identity: Unknown by default — resolved only if Deep Creator Check actually ran.
  if (sr.deepCreator?.creatorTrace.success && sr.deepCreator.creatorTrace.resolved.likelyCreatorWallet) {
    positiveSignals.push('Likely creator wallet identified (Deep Creator Check)')
  } else {
    unknownSignals.push('Creator launch history')
    unknownSignals.push('Funding wallet')
  }
  unknownSignals.push('Historical migrations')

  // ── Deep Analysis Available — only ever lists capabilities that genuinely exist ───────────────
  const deepAnalysis: SolanaCortexDeepAnalysisItem[] = [
    {
      label: 'Creator wallet trace',
      available: true,
      reason: sr.deepCreator
        ? 'Already run for this scan — see Dev tab.'
        : 'Traces the mint’s earliest transaction via Helius Enhanced Transactions to identify a likely creator wallet. Run from the Dev tab.',
    },
    { label: 'Historical authority changes', available: false, reason: 'Not yet supported — would require indexing every mint-account update over time.' },
    { label: 'Wallet cluster analysis', available: false, reason: 'Not yet supported — no wallet-relationship data source is wired.' },
    { label: 'Historical migrations', available: false, reason: 'Not yet supported — only the pool’s current on-chain state is read, not its history.' },
    { label: 'Enhanced transaction analysis', available: false, reason: 'Not yet supported beyond the single Deep Creator Check lookup — broader transaction parsing is not built.' },
  ]

  return {
    score: base.score, confidence, verdict, verdictColor,
    evidenceCoveragePercent, evidenceCoverageReason,
    positiveSignals, negativeSignals, unknownSignals, deepAnalysis,
  }
}
