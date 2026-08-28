// PUMP-INTELLIGENCE-REPORT, DISCLOSED (explicitly requested: a dedicated report per Pump Alert
// explaining WHY it pumped and whether it continues, "not a token scan page", with an explicit
// honesty contract — "Never fabricate evidence... Unknown remains Unknown... Separate verified
// facts from probabilistic inference").
//
// This module is deliberately a RESHAPING layer, not a fresh analysis engine. /api/token's POST
// handler already computes a rich, real RiskEngine (rugRiskScore, sniperActivity, holderIntelligence,
// smartMoney, deployerProfile, lpIntelligence, trendIntelligence) plus real poolActivity
// (buys24h/sells24h from GeckoTerminal's transactions.h24, pairCreatedAt) and holderDistribution
// (top1/top10/top20). Reimplementing that from scratch here would both duplicate thousands of
// lines of already-correct logic and risk drifting out of sync with it. So this module takes that
// response (fetched by the API route via an internal call) plus real per-token whale_alerts rows
// (Supabase, the only genuine per-token wallet event log in this codebase) and maps both into the
// 10-section report shape the product spec asks for.
//
// What genuinely does NOT exist anywhere in this codebase today (confirmed via a full audit before
// writing this file) and is therefore ALWAYS marked unavailable, never estimated:
//   - Historical Similarity (section 8): no table anywhere stores past pump outcomes (peak,
//     retrace, lifespan) to compare against. Zero real backing — not "low confidence", genuinely
//     Not Available.
//   - Liquidity trend / Holder growth trend: both GoldRush holder count and GT liquidity are
//     single point-in-time snapshots; deriveMigrationProof (lib/server/lpProof.ts) already
//     independently reaches the same conclusion for liquidity ("historical_liquidity_movement_
//     unavailable"). No polling/storage job exists to produce a real trend.
//   - Creator/deployer wallet activity and cluster/insider-concentration analysis: built and real
//     for Solana (clusterAnalyzer.ts, creatorAnalyzer.ts) but has no Base/EVM equivalent.
//   - Bundle activity, wash trading, bot activity: not implemented anywhere for any chain.
// Sniper detection IS real (token/route.ts's sniperActivity, derived from abnormal tx count on a
// young pool) and is surfaced under Risk Analysis.

export type Confidence = 'high' | 'medium' | 'low' | 'unavailable'

export interface EvidenceItem<T> {
  value: T
  confidence: Confidence
  evidence: string
}

export interface Catalyst {
  label: string
  evidence: string
  source: string
  confidence: Confidence
  impact: 'high' | 'medium' | 'low'
}

export interface RiskFactor {
  label: string
  status: 'confirmed' | 'possible' | 'clear' | 'unknown' | 'unsupported'
  confidence: Confidence
  evidence: string
  impact: 'high' | 'medium' | 'low'
}

export interface KillSignal {
  label: string
  probability: 'high' | 'medium' | 'low' | 'unknown'
  evidence: string
}

export interface ContinuationSignal {
  label: string
  status: boolean | null
  detail: string
}

export interface TimelineEvent {
  timestamp: string
  label: string
  kind: 'whale_buy' | 'whale_sell' | 'pool_created' | 'other'
}

export interface WalletRow {
  address: string
  side: 'buy' | 'sell'
  amountUsd: number | null
  occurredAt: string
  isTracked: boolean
}

export interface WatchItem {
  label: string
  threshold: string
}

export interface PumpIntelligenceReport {
  contract: string
  chain: string
  symbol: string
  name: string
  generatedAt: string
  executiveSummary: {
    momentumScore: number | null
    momentumConfidence: Confidence
    momentumEvidence: string
    continuationScore: number | null
    continuationProbability: 'high' | 'medium' | 'low' | 'unavailable'
    continuationEvidence: string
    pullbackRiskScore: number | null
    pullbackRisk: 'high' | 'medium' | 'low' | 'unavailable'
    pullbackEvidence: string
    confidenceScore: number
    overallConfidence: Confidence
    verdict: string
  }
  catalysts: Catalyst[]
  marketStructure: {
    buys24h: number | null
    sells24h: number | null
    txns24h: number | null
    buySellRatio: number | null
    txnsSource: 'geckoterminal' | 'dexscreener' | 'none'
    txnsUnavailableReason: string | null
    liquidityUsd: number | null
    liquiditySource: 'alert_payload' | 'dexscreener' | 'none'
    liquidityTrend: EvidenceItem<null>
    volume24hUsd: number | null
    holderCount: number | null
    holderCountCapped: boolean
    holderSource: 'token_scanner' | 'goldrush' | 'none'
    holderUnavailableReason: string | null
    holderTrend: EvidenceItem<null>
    fdvUsd: number | null
    fdvSource: 'alert_payload' | 'dexscreener' | 'token_scanner' | 'none'
    marketCapUsd: number | null
    marketCapSource: 'alert_payload' | 'dexscreener' | 'token_scanner' | 'internal_snapshot' | 'none'
    marketCapUnavailableReason: string | null
    ageHours: number | null
    priceChange24h: number | null
    priceChange6h: number | null
    priceChange1h: number | null
    priceChange7d: number | null
    top1HolderPercent: number | null
    top10HolderPercent: number | null
  }
  reportMarket: ReportMarket
  walletIntelligence: {
    largestBuyers: WalletRow[]
    largestSellers: WalletRow[]
    netWhaleFlowUsd: number | null
    newWalletBuyerCount: number | null
    trackedWalletActivity: WalletRow[]
    creatorActivity: EvidenceItem<null>
    clusterAnalysis: EvidenceItem<null>
    eventCount: number
    dataSource: string
  }
  riskAnalysis: RiskFactor[]
  killSignals: KillSignal[]
  continuationSignals: ContinuationSignal[]
  historicalSimilarity: { available: false; reason: string }
  watchlist: WatchItem[]
  timeline: TimelineEvent[]
  evidenceGaps: string[]
  dataResolutionAudit: PumpReportDataResolutionAudit
  marketDataAudit: PumpReportMarketDataAudit
  pumpReportEvidenceAudit: PumpReportEvidenceAudit
}

export interface PumpAlertInput {
  symbol: string
  name: string
  contract: string
  priceUsd: number | null
  change24h: number | null
  change7d?: number | null
  change6h?: number | null
  change1h?: number | null
  marketCapUsd?: number | null
  tokenAgeDays?: number | null
  pairAddress?: string | null
  evidenceGrade?: 'exact' | 'live_momentum' | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  reason: string
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW'
}

export interface DexScreenerMarketEvidence {
  priceUsd: number | null
  marketCapUsd: number | null
  fdvUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  volume6hUsd: number | null
  volume1hUsd: number | null
  priceChange24hPct: number | null
  priceChange6hPct: number | null
  priceChange1hPct: number | null
  buys24h: number | null
  sells24h: number | null
  buys6h: number | null
  sells6h: number | null
  buys1h: number | null
  sells1h: number | null
  pairCreatedAt: number | null
}

export interface ReportMarket {
  priceUsd: number | null
  marketCapUsd: number | null
  marketCapSource: 'alert_payload' | 'dexscreener' | 'token_scanner' | 'internal_snapshot' | 'none'
  marketCapUnavailableReason: string | null
  fdvUsd: number | null
  fdvSource: 'alert_payload' | 'dexscreener' | 'token_scanner' | 'none'
  liquidityUsd: number | null
  liquiditySource: 'alert_payload' | 'dexscreener' | 'none'
  volume24hUsd: number | null
  volume6hUsd: number | null
  volume1hUsd: number | null
  priceChange24hPct: number | null
  priceChange6hPct: number | null
  priceChange1hPct: number | null
  buys24h: number | null
  sells24h: number | null
  txns24h: number | null
  buySellRatio: number | null
  pairAgeHours: number | null
  chainSlug: string
  pairAddress: string | null
}

export interface PumpReportDataResolutionAudit {
  tokenAddress: string
  chainSlug: string
  pairAddress: string | null
  openedFromAlert: boolean
  alertPayloadReceived: boolean
  fieldsFromAlertPayload: string[]
  dexScreenerAttempted: boolean
  dexScreenerSucceeded: boolean
  dexScreenerFieldsResolved: string[]
  geckoTerminalAttempted: boolean
  geckoTerminalSucceeded: boolean
  geckoFieldsResolved: string[]
  snapshotsAttempted: boolean
  snapshotsSucceeded: boolean
  tokenScannerAttempted: boolean
  tokenScannerSucceeded: boolean
  tokenScannerFieldsResolved: string[]
  whaleDataAttempted: boolean
  whaleDataSucceeded: boolean
  computedMomentumScore: number | null
  computedContinuationProbability: string | null
  computedPullbackRisk: string | null
  unavailableFields: string[]
  unavailableReasons: string[]
}

export interface PumpReportMarketDataAudit {
  tokenAddress: string
  chainSlug: string
  pairAddress: string | null
  openedFromAlert: boolean
  alertPayloadFields: string[]
  dexScreenerAttempted: boolean
  dexScreenerSucceeded: boolean
  dexScreenerMarketCap: number | null
  dexScreenerFdv: number | null
  dexScreenerTxnsAvailable: boolean
  geckoAttempted: boolean
  geckoSucceeded: boolean
  tokenScannerAttempted: boolean
  tokenScannerSucceeded: boolean
  resolvedMarketCapUsd: number | null
  marketCapSource: string
  resolvedFdvUsd: number | null
  fdvSource: string
  resolvedBuys24h: number | null
  resolvedSells24h: number | null
  resolvedTxns24h: number | null
  unavailableFields: string[]
  unavailableReasons: string[]
}

// EVIDENCE-AUDIT, DISCLOSED (requested shape, verbatim). A THIRD audit object, additive to
// dataResolutionAudit/marketDataAudit above (neither is replaced — existing tests assert on both) —
// this one exists purely to answer "why does this field show what it shows" per-field, including the
// confidence weighting itself, in the exact shape the fix was specified against.
export interface PumpReportEvidenceAudit {
  tokenAddress: string
  chainSlug: string
  seedUsed: boolean
  sourcesAttempted: string[]
  sourcesSucceeded: string[]
  marketCapSource: string
  fdvSource: string
  liquiditySource: string
  volumeSource: string
  ageSource: string
  txnSplitSource: string
  holderSource: string
  securitySource: string
  unavailableFields: string[]
  unavailableReasons: string[]
  confidenceInputs: { key: string; label: string; verified: boolean; weight: number }[]
  finalConfidence: Confidence
}

export type TokenAnalysisSlice = Record<string, unknown>

export interface WhaleAlertRow {
  wallet_address: string
  side: 'buy' | 'sell' | string
  amount_usd: number | null
  occurred_at: string
}

function pick<T = unknown>(obj: Record<string, unknown> | null | undefined, path: string[]): T | null {
  let cur: unknown = obj
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[key]
  }
  return (cur ?? null) as T | null
}

export type LiveScoreResult = { score: number | null; evidenceCount: number; parts: string[] }

export function chainTokenLabel(chain: string): string {
  const c = chain.toLowerCase()
  if (c === 'eth' || c === 'ethereum') return 'Ethereum'
  if (c === 'robinhood') return 'Robinhood Chain'
  if (c === 'base') return 'Base'
  return chain
}

export function computeLiveMomentumScore(alert: PumpAlertInput): LiveScoreResult {
  const parts: string[] = []
  let evidenceCount = 0
  if (alert.change24h == null && alert.volume24hUsd == null && alert.liquidityUsd == null) {
    return { score: null, evidenceCount: 0, parts }
  }
  let score = 50
  if (alert.change24h != null) {
    evidenceCount += 1
    const bump = alert.change24h >= 0 ? Math.min(alert.change24h / 2, 30) : -Math.min(Math.abs(alert.change24h) / 2, 20)
    score += bump
    parts.push(`24h change ${alert.change24h >= 0 ? '+' : ''}${alert.change24h.toFixed(1)}%`)
  }
  if (alert.change6h != null && alert.change1h != null) {
    evidenceCount += 1
    if (alert.change6h > 0 && alert.change1h > 0) { score += 8; parts.push('6h/1h still positive (accelerating)') }
    else if (alert.change24h != null && alert.change24h > 0 && alert.change1h < 0) { score -= 8; parts.push('1h has turned negative (fading)') }
  }
  if (alert.volume24hUsd != null && alert.liquidityUsd != null && alert.liquidityUsd > 0) {
    evidenceCount += 1
    const ratio = alert.volume24hUsd / alert.liquidityUsd
    if (ratio >= 3) { score += 10; parts.push(`volume/liquidity ${ratio.toFixed(1)}x (high turnover)`) }
    else if (ratio < 0.3) { score -= 8; parts.push(`volume/liquidity ${ratio.toFixed(2)}x (stagnant)`) }
  }
  if (alert.liquidityUsd != null) {
    evidenceCount += 1
    if (alert.liquidityUsd >= 100_000) { score += 5; parts.push('liquidity depth ≥ $100K') }
    else if (alert.liquidityUsd < 10_000) { score -= 10; parts.push('liquidity depth < $10K (thin)') }
  }
  const capTier = alert.fdvUsd ?? alert.marketCapUsd
  if (capTier != null) {
    evidenceCount += 1
    if (capTier <= 1_000_000) { score += 3; parts.push('low FDV/MCap tier') }
    else if (capTier >= 20_000_000) { score -= 8; parts.push('high FDV/MCap tier') }
  }
  if (alert.riskLevel === 'HIGH') { score -= 12; parts.push('HIGH risk level penalty') }
  else if (alert.riskLevel === 'MEDIUM') { score -= 4; parts.push('MEDIUM risk level penalty') }
  return { score: Math.round(Math.max(0, Math.min(100, score))), evidenceCount, parts }
}

export function computeLiveContinuationProbability(
  alert: PumpAlertInput, buys24h: number | null, sells24h: number | null,
): { band: 'high' | 'medium' | 'low' | 'unavailable'; points: number; maxPoints: number; parts: string[] } {
  if (alert.change24h == null) return { band: 'unavailable', points: 0, maxPoints: 0, parts: [] }
  const parts: string[] = []
  let points = 0
  let maxPoints = 0
  maxPoints += 1
  if (alert.change24h > 0) { points += 1; parts.push('positive 24h momentum') }
  if (alert.change6h != null || alert.change1h != null) {
    maxPoints += 1
    if ((alert.change6h ?? 0) > 0 || (alert.change1h ?? 0) > 0) { points += 1; parts.push('short-window momentum still positive') }
  }
  if (alert.volume24hUsd != null && alert.liquidityUsd != null && alert.liquidityUsd > 0) {
    maxPoints += 1
    if (alert.volume24hUsd / alert.liquidityUsd >= 1.5) { points += 1; parts.push('healthy volume/liquidity ratio') }
  }
  if (alert.liquidityUsd != null) {
    maxPoints += 1
    if (alert.liquidityUsd >= 50_000) { points += 1; parts.push('adequate liquidity depth') }
  }
  const capTier = alert.fdvUsd ?? alert.marketCapUsd
  if (capTier != null) {
    maxPoints += 1
    if (capTier <= 10_000_000) { points += 1; parts.push('FDV/MCap tier leaves room to grow') }
  }
  maxPoints += 1
  if (alert.riskLevel !== 'HIGH') { points += 1; parts.push('not flagged HIGH risk') }
  if (buys24h != null && sells24h != null && buys24h + sells24h > 0) {
    maxPoints += 2
    const ratio = sells24h > 0 ? buys24h / sells24h : buys24h > 0 ? 2 : 1
    if (ratio > 1) { points += 2; parts.push(`buy/sell ratio ${ratio.toFixed(2)}:1`) }
    else if (ratio < 0.8) { points -= 1; parts.push(`buy/sell ratio ${ratio.toFixed(2)}:1 (sell pressure)`) }
  }
  const ratioOfMax = maxPoints > 0 ? points / maxPoints : 0
  const band: 'high' | 'medium' | 'low' = ratioOfMax >= 0.7 ? 'high' : ratioOfMax >= 0.4 ? 'medium' : 'low'
  return { band, points, maxPoints, parts }
}

export function computeLivePullbackRisk(
  alert: PumpAlertInput, hasTokenAnalysis: boolean, honeypotResolved: boolean,
): { band: 'high' | 'medium' | 'low' | 'unavailable'; points: number; parts: string[] } {
  if (alert.change24h == null && alert.liquidityUsd == null) return { band: 'unavailable', points: 0, parts: [] }
  const parts: string[] = []
  let points = 0
  if (alert.change24h != null) {
    if (alert.change24h >= 200) { points += 2; parts.push(`extreme 24h pump (+${alert.change24h.toFixed(0)}%)`) }
    else if (alert.change24h >= 100) { points += 1; parts.push(`large 24h pump (+${alert.change24h.toFixed(0)}%)`) }
  }
  if (alert.liquidityUsd != null) {
    if (alert.liquidityUsd < 10_000) { points += 2; parts.push('very thin liquidity (<$10K)') }
    else if (alert.liquidityUsd < 30_000) { points += 1; parts.push('thin liquidity (<$30K)') }
  }
  if (alert.volume24hUsd != null && alert.liquidityUsd != null && alert.liquidityUsd > 0) {
    const ratio = alert.volume24hUsd / alert.liquidityUsd
    if (ratio >= 5) { points += 2; parts.push(`extreme volume/liquidity ratio (${ratio.toFixed(1)}x)`) }
    else if (ratio >= 3) { points += 1; parts.push(`high volume/liquidity ratio (${ratio.toFixed(1)}x)`) }
  }
  if (alert.tokenAgeDays != null) {
    if (alert.tokenAgeDays < 0.25) { points += 2; parts.push('very young pool (<6h old)') }
    else if (alert.tokenAgeDays < 1) { points += 1; parts.push('young pool (<24h old)') }
  }
  const capTier = alert.fdvUsd ?? alert.marketCapUsd
  if (capTier != null && capTier >= 20_000_000) { points += 1; parts.push('high FDV/MCap tier') }
  if (!hasTokenAnalysis) { points += 1; parts.push('LP control unresolved') }
  if (!honeypotResolved) { points += 1; parts.push('tax/honeypot status unresolved') }
  const band: 'high' | 'medium' | 'low' = points >= 6 ? 'high' : points >= 3 ? 'medium' : 'low'
  return { band, points, parts }
}

export function buildPumpIntelligenceReport(params: {
  alert: PumpAlertInput
  chain: string
  tokenAnalysis: TokenAnalysisSlice | null
  whaleRows: WhaleAlertRow[]
  trackedAddresses: Set<string>
  dexScreenerMarket?: DexScreenerMarketEvidence | null
  dexScreenerAttempted?: boolean
  dexScreenerSucceeded?: boolean
  snapshotChange14d?: number | null
  snapshotsAttempted?: boolean
  snapshotsSucceeded?: boolean
  latestSnapshot?: { market_cap_usd: number | null; fdv_usd: number | null } | null
  tokenScannerAttempted?: boolean
  whaleDataAttempted?: boolean
  // HOLDER-EVIDENCE-ENRICHMENT, DISCLOSED (requested: "Pump Report should use every available
  // ChainLens/provider source before showing unavailable" — Holders/Top holder/Top 10 holders had
  // ZERO fallback anywhere in this route; they were sourced exclusively from Token Scanner's /api/
  // token call, so any Token Scanner failure/timeout took all three straight to "Unavailable" with
  // no attempt at the same GoldRush holder module Base Radar already relies on. GoldRush only
  // covers 'base'/'robinhood' (lib/server/goldrushHolderCount.ts) — 'eth' has no non-Token-Scanner
  // holder source in this codebase, so it is honestly reported as chain-unsupported, never retried
  // against the wrong provider.
  goldRushHolderCount?: number | null
  goldRushHolderCountCapped?: boolean
  goldRushTop1?: number | null
  goldRushTop10?: number | null
  holderProviderChainSupported?: boolean
  holderProviderAttempted?: boolean
  holderProviderSucceeded?: boolean
}): PumpIntelligenceReport {
  const {
    alert, chain, tokenAnalysis, whaleRows, trackedAddresses,
    dexScreenerMarket = null, dexScreenerAttempted = false, dexScreenerSucceeded = false,
    snapshotChange14d = null, snapshotsAttempted = false, snapshotsSucceeded = false,
    latestSnapshot = null,
    tokenScannerAttempted = tokenAnalysis != null, whaleDataAttempted = true,
    goldRushHolderCount = null, goldRushHolderCountCapped = false, goldRushTop1 = null, goldRushTop10 = null,
    holderProviderChainSupported = false, holderProviderAttempted = false, holderProviderSucceeded = false,
  } = params
  const evidenceGaps: string[] = []
  const gap = (msg: string) => { evidenceGaps.push(msg) }

  const riskEngine = pick<Record<string, unknown>>(tokenAnalysis, ['riskEngine'])
  const poolActivity = pick<Record<string, unknown>>(tokenAnalysis, ['poolActivity'])
  const holderDistribution = pick<Record<string, unknown>>(tokenAnalysis, ['holderDistribution'])
  const holderResolver = pick<Record<string, unknown>>(tokenAnalysis, ['holderResolver'])
  const holderIntelligence = pick<Record<string, unknown>>(riskEngine, ['holderIntelligence'])
  const smartMoney = pick<Record<string, unknown>>(riskEngine, ['smartMoney'])
  const sniperActivity = pick<Record<string, unknown>>(riskEngine, ['sniperActivity'])
  const lpRisk = pick<Record<string, unknown>>(riskEngine, ['lpRisk'])

  const gtBuys24h = pick<number>(poolActivity, ['buys24h'])
  const gtSells24h = pick<number>(poolActivity, ['sells24h'])
  let buys24h: number | null = gtBuys24h
  let sells24h: number | null = gtSells24h
  let txnsSource: 'geckoterminal' | 'dexscreener' | 'none' = gtBuys24h != null && gtSells24h != null ? 'geckoterminal' : 'none'
  if (txnsSource === 'none' && dexScreenerMarket && dexScreenerMarket.buys24h != null && dexScreenerMarket.sells24h != null) {
    buys24h = dexScreenerMarket.buys24h
    sells24h = dexScreenerMarket.sells24h
    txnsSource = 'dexscreener'
  }
  const txns24h = buys24h != null && sells24h != null ? buys24h + sells24h : null
  // EXACT-WORDING FIX, DISCLOSED (required copy: "If provider does not return split, show:
  // 'Transaction split unavailable from provider' not generic unavailable").
  const txnsUnavailableReason = txnsSource === 'none' ? 'Transaction split unavailable from provider.' : null

  const pairCreatedAtIso = pick<string>(poolActivity, ['pairCreatedAt'])
  const dexScreenerPairAgeHours = dexScreenerMarket?.pairCreatedAt != null
    ? (Date.now() - dexScreenerMarket.pairCreatedAt) / 3_600_000
    : null
  const ageHours = pairCreatedAtIso
    ? (Date.now() - new Date(pairCreatedAtIso).getTime()) / 3_600_000
    : dexScreenerPairAgeHours
      ?? (alert.tokenAgeDays != null ? alert.tokenAgeDays * 24 : null)
  const tokenScannerHolderCount = pick<number>(holderResolver, ['holderCount']) ?? pick<number>(tokenAnalysis, ['holderCount'])
  let holderCount: number | null = tokenScannerHolderCount
  let holderCountCapped = pick<boolean>(tokenAnalysis, ['holderCountCapped']) ?? false
  let holderCountSource: 'token_scanner' | 'goldrush' | 'none' = tokenScannerHolderCount != null ? 'token_scanner' : 'none'
  if (holderCount == null && goldRushHolderCount != null) {
    holderCount = goldRushHolderCount
    holderCountCapped = goldRushHolderCountCapped
    holderCountSource = 'goldrush'
  }
  let top1HolderPercent = pick<number>(holderDistribution, ['top1'])
  let top10HolderPercent = pick<number>(holderDistribution, ['top10'])
  let holderConcentrationSource: 'token_scanner' | 'goldrush' | 'none' = top1HolderPercent != null || top10HolderPercent != null ? 'token_scanner' : 'none'
  if (top1HolderPercent == null && goldRushTop1 != null) { top1HolderPercent = goldRushTop1; holderConcentrationSource = 'goldrush' }
  if (top10HolderPercent == null && goldRushTop10 != null) { top10HolderPercent = goldRushTop10; holderConcentrationSource = 'goldrush' }
  const holderSource: 'token_scanner' | 'goldrush' | 'none' = holderCountSource !== 'none' ? holderCountSource : holderConcentrationSource
  // HOLDER-UNAVAILABLE-WORDING, DISCLOSED (hard rule: "Do NOT show 'Unavailable' until all correct
  // sources were attempted" + required exact wording "Holders unsupported for this chain/provider"
  // for a chain no holder provider covers, distinct from "Provider unavailable" when the provider(s)
  // that DO cover this chain were tried and came back empty).
  const holderUnavailableReason = holderCount != null ? null
    : !holderProviderChainSupported && tokenAnalysis == null
      ? `Holders unsupported for this chain/provider — no holder provider covers ${chainTokenLabel(chain)} yet, and Token Scanner did not resolve.`
      : !holderProviderChainSupported
        ? 'Holders unsupported for this chain/provider — no holder provider covers this chain yet.'
        : holderProviderAttempted && !holderProviderSucceeded
          ? 'Provider unavailable — GoldRush did not return holder data for this token.'
          : 'Not returned — no supported holder provider returned data for this token.'

  const tokenScannerMarketCap = pick<number>(tokenAnalysis, ['marketCap', 'value']) ?? pick<number>(tokenAnalysis, ['marketCapUsd'])
  let marketCapUsd: number | null = null
  let marketCapSource: ReportMarket['marketCapSource'] = 'none'
  if (alert.marketCapUsd != null) { marketCapUsd = alert.marketCapUsd; marketCapSource = 'alert_payload' }
  else if (dexScreenerMarket?.marketCapUsd != null) { marketCapUsd = dexScreenerMarket.marketCapUsd; marketCapSource = 'dexscreener' }
  else if (tokenScannerMarketCap != null) { marketCapUsd = tokenScannerMarketCap; marketCapSource = 'token_scanner' }
  else if (latestSnapshot?.market_cap_usd != null) { marketCapUsd = latestSnapshot.market_cap_usd; marketCapSource = 'internal_snapshot' }

  const tokenScannerFdv = pick<number>(tokenAnalysis, ['fdv']) ?? pick<number>(tokenAnalysis, ['fdvUsd'])
  let fdvUsd: number | null = null
  let fdvSource: ReportMarket['fdvSource'] = 'none'
  if (alert.fdvUsd != null) { fdvUsd = alert.fdvUsd; fdvSource = 'alert_payload' }
  else if (dexScreenerMarket?.fdvUsd != null) { fdvUsd = dexScreenerMarket.fdvUsd; fdvSource = 'dexscreener' }
  else if (tokenScannerFdv != null) { fdvUsd = tokenScannerFdv; fdvSource = 'token_scanner' }

  const marketCapUnavailableReason = marketCapUsd != null ? null
    : fdvUsd != null ? 'FDV available; circulating supply market cap not verified.'
    : 'No supported provider (alert payload, DexScreener, Token Scanner, or a cached snapshot) returned a verified market cap for this token.'

  let liquidityUsd: number | null = alert.liquidityUsd
  let liquiditySource: ReportMarket['liquiditySource'] = alert.liquidityUsd != null ? 'alert_payload' : 'none'
  if (liquidityUsd == null && dexScreenerMarket?.liquidityUsd != null) {
    liquidityUsd = dexScreenerMarket.liquidityUsd
    liquiditySource = 'dexscreener'
  }

  const rugRiskScore = pick<number>(riskEngine, ['rugRiskScore'])
  const rugRiskLabel = pick<string>(riskEngine, ['rugRiskLabel'])
  const riskDrivers = pick<string[]>(riskEngine, ['riskDrivers']) ?? []
  const verifiedSignals = pick<string[]>(riskEngine, ['verifiedSignals']) ?? []
  const clarkInterpretation = pick<string>(riskEngine, ['clarkInterpretation'])
  const change7dOrExact = alert.change7d ?? snapshotChange14d ?? null
  const honeypotResolved = (pick<boolean>(tokenAnalysis, ['honeypot', 'isHoneypot']) ?? pick<boolean>(tokenAnalysis, ['honeypot'])) != null

  const liveMomentum = computeLiveMomentumScore(alert)
  const liveContinuation = computeLiveContinuationProbability(alert, buys24h, sells24h)
  const livePullback = computeLivePullbackRisk(alert, tokenAnalysis != null, honeypotResolved)

  const buySellRatio = buys24h != null && sells24h != null && sells24h > 0 ? buys24h / sells24h : null
  const cortexMomentum = rugRiskScore != null ? Math.max(0, 100 - rugRiskScore) : null
  let momentumScore: number | null = null
  let momentumConfidence: Confidence = 'unavailable'
  if (liveMomentum.score != null && cortexMomentum != null) {
    momentumScore = Math.round((liveMomentum.score + cortexMomentum) / 2)
    momentumConfidence = 'high'
  } else if (cortexMomentum != null) {
    momentumScore = cortexMomentum
    momentumConfidence = 'medium'
  } else if (liveMomentum.score != null) {
    momentumScore = liveMomentum.score
    momentumConfidence = liveMomentum.evidenceCount >= 3 ? 'medium' : 'low'
  } else {
    gap('Momentum score unavailable — neither live market evidence (price/volume/liquidity) nor the CORTEX risk read resolved for this token.')
  }
  const momentumEvidenceNote = liveMomentum.score != null
    ? (cortexMomentum != null ? `Blended: live market structure (${liveMomentum.parts.join(', ') || 'limited evidence'}) + CORTEX risk read.` : `Live estimate from ${liveMomentum.parts.join(', ') || 'available market evidence'} — CORTEX risk read unavailable.`)
    : 'CORTEX inverse risk score.'

  const continuationScore = buys24h != null && sells24h != null && buys24h + sells24h > 0
    ? Math.round((buys24h / (buys24h + sells24h)) * 100)
    : (liveContinuation.band !== 'unavailable' ? Math.round((liveContinuation.maxPoints > 0 ? liveContinuation.points / liveContinuation.maxPoints : 0) * 100) : null)
  const continuationProbability: 'high' | 'medium' | 'low' | 'unavailable' = liveContinuation.band
  let continuationEvidence = 'Insufficient verified signals to estimate continuation.'
  if (liveContinuation.band !== 'unavailable') {
    const base = liveContinuation.parts.length > 0 ? liveContinuation.parts.join(', ') : 'limited live evidence'
    continuationEvidence = buySellRatio != null
      ? `${base} (buy/sell ratio ${buySellRatio.toFixed(2)}:1).`
      : `Estimated from live market structure — buy/sell split unavailable. Signals: ${base}.`
  } else {
    gap('Continuation probability unavailable — no live price/volume evidence and real-time buy/sell counts did not resolve.')
  }

  let pullbackRisk: 'high' | 'medium' | 'low' | 'unavailable' = livePullback.band
  let pullbackRiskScore = livePullback.band !== 'unavailable' ? Math.min(100, livePullback.points * 14) : null
  let pullbackEvidence = livePullback.parts.length > 0 ? `Live evidence: ${livePullback.parts.join(', ')}.` : 'Insufficient verified signals to estimate pullback risk.'
  const bandRank = { unavailable: -1, low: 0, medium: 1, high: 2 } as const
  if (rugRiskLabel) {
    const cortexBand: 'high' | 'medium' | 'low' = rugRiskLabel === 'critical' || rugRiskLabel === 'high' ? 'high' : rugRiskLabel === 'watch' ? 'medium' : 'low'
    if (bandRank[cortexBand] >= bandRank[pullbackRisk]) {
      pullbackRisk = cortexBand
      pullbackRiskScore = rugRiskScore ?? pullbackRiskScore
      pullbackEvidence = clarkInterpretation ?? `CORTEX risk label: ${rugRiskLabel}.${livePullback.parts.length > 0 ? ` Live signals: ${livePullback.parts.join(', ')}.` : ''}`
    }
  }
  if (pullbackRisk === 'unavailable') gap('Pullback risk unavailable — no live pump-size/liquidity/age evidence and the CORTEX risk read did not resolve.')

  // CONFIDENCE-0 FIX, DISCLOSED (live report: "still shows Confidence 0" despite strong live market
  // evidence — 24h change/liquidity/volume/FDV/pool age all present). Root cause: the old formula
  // scored 5 booleans, 4 of which (rugRiskScore/lpRisk/holderDistribution/riskEngine) hard-required
  // Token Scanner to succeed — a single Token Scanner failure/timeout zeroed confidence even when
  // every other independent source (alert seed, DexScreener, snapshots) had resolved cleanly. Hard
  // rule: "Do NOT require holders/wallet intelligence to calculate basic confidence." New formula
  // weights base market-structure evidence (price change/volume/liquidity/market data/pool age —
  // sources that never depend on Token Scanner) at 60 of 100 points, so full base coverage alone
  // lands at 'medium', never 'unavailable'; txn split/holders/security are "extra" points on top
  // that can push it to 'high'. Bands: 0=unavailable, 1-39=low, 40-69=medium, 70-100=high.
  const confidenceInputs = [
    { key: 'price_change', label: 'Price change verified', verified: alert.change24h != null, weight: 10 },
    { key: 'volume', label: 'Volume verified', verified: alert.volume24hUsd != null, weight: 10 },
    { key: 'liquidity', label: 'Liquidity verified', verified: liquidityUsd != null, weight: 15 },
    { key: 'market_data', label: 'FDV/market cap verified', verified: marketCapUsd != null || fdvUsd != null, weight: 15 },
    { key: 'pool_age', label: 'Pool age verified', verified: ageHours != null, weight: 10 },
    { key: 'txn_split', label: 'Transaction split verified', verified: txnsSource !== 'none', weight: 15 },
    { key: 'holders', label: 'Holders verified', verified: holderCount != null, weight: 15 },
    { key: 'security', label: 'Token security verified', verified: honeypotResolved, weight: 10 },
  ]
  const confidenceScore = confidenceInputs.reduce((sum, c) => sum + (c.verified ? c.weight : 0), 0)
  const overallConfidence: Confidence = confidenceScore === 0 ? 'unavailable'
    : confidenceScore >= 70 ? 'high'
    : confidenceScore >= 40 ? 'medium'
    : 'low'

  const verdictParts: string[] = []
  verdictParts.push(`${alert.symbol} ${alert.reason.toLowerCase()}.`)
  if (buySellRatio != null) verdictParts.push(`Real-time transactions show a ${buySellRatio.toFixed(2)}:1 buy/sell ratio over 24h.`)
  else if (momentumScore != null) verdictParts.push(`Live momentum score ${momentumScore}/100 from real price/volume/liquidity evidence.`)
  if (riskDrivers.length > 0) verdictParts.push(`Key risk: ${riskDrivers[0]}.`)
  else if (verifiedSignals.length > 0) verdictParts.push(`Verified: ${verifiedSignals[0]}.`)
  if (tokenAnalysis == null) verdictParts.push('Full CORTEX analysis was unavailable for this token — this read is based on live pump-detection market evidence only.')
  const verdict = verdictParts.join(' ')

  const catalysts: Catalyst[] = []
  const whaleBuys = whaleRows.filter(r => r.side === 'buy')
  const whaleSells = whaleRows.filter(r => r.side === 'sell')
  if (whaleBuys.length > 0) {
    const totalUsd = whaleBuys.reduce((s, r) => s + (r.amount_usd ?? 0), 0)
    catalysts.push({
      label: 'Whale accumulation',
      evidence: `${whaleBuys.length} tracked whale buy(s) totaling ~$${Math.round(totalUsd).toLocaleString()} in the monitored window.`,
      source: 'Whale monitor',
      confidence: 'high',
      impact: whaleBuys.length >= 3 ? 'high' : 'medium',
    })
  }
  if (buys24h != null && sells24h != null && buys24h > sells24h * 1.2) {
    catalysts.push({
      label: 'Buy pressure',
      evidence: `${buys24h} buy transactions vs ${sells24h} sell transactions in the last 24h (GeckoTerminal).`,
      source: 'GeckoTerminal',
      confidence: 'high',
      impact: 'medium',
    })
  }
  if ((alert.volume24hUsd ?? 0) >= 250_000) {
    catalysts.push({
      label: 'Volume expansion',
      evidence: `24h volume of $${Math.round(alert.volume24hUsd ?? 0).toLocaleString()}.`,
      source: 'GeckoTerminal',
      confidence: 'high',
      impact: (alert.volume24hUsd ?? 0) >= 1_000_000 ? 'high' : 'medium',
    })
  }
  const lpLockStatus = pick<string>(tokenAnalysis, ['liquidityStatus'])
  if (lpLockStatus === 'locked' || lpLockStatus === 'burned') {
    catalysts.push({
      label: 'Liquidity secured',
      evidence: `LP is ${lpLockStatus} — reduces one common rug vector, which may support continued trading confidence.`,
      source: 'LP proof / CORTEX',
      confidence: pick<string>(lpRisk, ['confidence']) as Confidence ?? 'medium',
      impact: 'low',
    })
  }
  if (smartMoney && pick<boolean>(smartMoney, ['detected'])) {
    catalysts.push({
      label: 'Smart-money activity',
      evidence: pick<string>(smartMoney, ['reason']) ?? 'Wallets with a prior track record were detected trading this token.',
      source: 'CORTEX wallet intelligence',
      confidence: pick<string>(smartMoney, ['confidence']) as Confidence ?? 'medium',
      impact: 'medium',
    })
  }
  if (catalysts.length === 0) {
    gap('No catalyst could be verified with real evidence — this pump is currently unexplained beyond raw price/volume movement.')
  }

  const volume6hUsd = dexScreenerMarket?.volume6hUsd ?? null
  const volume1hUsd = dexScreenerMarket?.volume1hUsd ?? null
  const priceChange6h = alert.change6h ?? dexScreenerMarket?.priceChange6hPct ?? null
  const priceChange1h = alert.change1h ?? dexScreenerMarket?.priceChange1hPct ?? null

  const marketStructure = {
    buys24h, sells24h, txns24h, buySellRatio, txnsSource, txnsUnavailableReason,
    liquidityUsd, liquiditySource,
    liquidityTrend: { value: null, confidence: 'unavailable' as Confidence, evidence: 'Liquidity is only ever observed as a point-in-time snapshot — no historical liquidity series is stored anywhere in this system.' },
    volume24hUsd: alert.volume24hUsd, holderCount, holderCountCapped, holderSource, holderUnavailableReason,
    holderTrend: { value: null, confidence: 'unavailable' as Confidence, evidence: 'Holder count is a live snapshot only — no polling job stores historical holder counts to compute growth.' },
    fdvUsd, fdvSource, marketCapUsd, marketCapSource, marketCapUnavailableReason, ageHours,
    priceChange24h: alert.change24h, priceChange6h, priceChange1h, priceChange7d: change7dOrExact,
    top1HolderPercent, top10HolderPercent,
  }
  if (holderCount == null) gap(`Holder count unavailable — ${holderUnavailableReason}`)
  if (ageHours == null) gap('Pool age unavailable — pool creation timestamp did not resolve.')
  if (change7dOrExact == null) gap('Exact 7d/14d change unavailable — GeckoTerminal OHLCV and internal snapshots did not resolve; this does not affect the live Momentum Score above.')
  if (txnsSource === 'none') gap(`Buys/sells unavailable — ${txnsUnavailableReason}`)
  if (marketCapUsd == null) gap(`Market cap unavailable — ${marketCapUnavailableReason}`)

  const reportMarket: ReportMarket = {
    priceUsd: alert.priceUsd ?? dexScreenerMarket?.priceUsd ?? null,
    marketCapUsd, marketCapSource, marketCapUnavailableReason, fdvUsd, fdvSource, liquidityUsd, liquiditySource,
    volume24hUsd: alert.volume24hUsd, volume6hUsd, volume1hUsd,
    priceChange24hPct: alert.change24h, priceChange6hPct: priceChange6h, priceChange1hPct: priceChange1h,
    buys24h, sells24h, txns24h, buySellRatio, pairAgeHours: ageHours, chainSlug: chain,
    pairAddress: alert.pairAddress ?? null,
  }

  const toWalletRow = (r: WhaleAlertRow): WalletRow => ({
    address: r.wallet_address, side: r.side === 'sell' ? 'sell' : 'buy', amountUsd: r.amount_usd,
    occurredAt: r.occurred_at, isTracked: trackedAddresses.has(r.wallet_address.toLowerCase()),
  })
  const sortedByUsd = [...whaleRows].sort((a, b) => (b.amount_usd ?? 0) - (a.amount_usd ?? 0))
  const largestBuyers = sortedByUsd.filter(r => r.side === 'buy').slice(0, 5).map(toWalletRow)
  const largestSellers = sortedByUsd.filter(r => r.side === 'sell').slice(0, 5).map(toWalletRow)
  const trackedWalletActivity = whaleRows.filter(r => trackedAddresses.has(r.wallet_address.toLowerCase())).map(toWalletRow)
  const pricedWhaleRows = whaleRows.filter((r): r is WhaleAlertRow & { amount_usd: number } =>
    r.amount_usd != null && (r.side === 'buy' || r.side === 'sell'))
  const netWhaleFlowUsd = pricedWhaleRows.length > 0
    ? pricedWhaleRows.reduce((sum, row) => sum + (row.side === 'sell' ? -row.amount_usd : row.amount_usd), 0)
    : null

  const walletIntelligence = {
    largestBuyers, largestSellers, netWhaleFlowUsd,
    newWalletBuyerCount: null as number | null, trackedWalletActivity,
    creatorActivity: { value: null, confidence: 'unavailable' as Confidence, evidence: 'Creator/deployer wallet resolution is built for Solana tokens only — no equivalent exists for Base tokens in this system yet.' },
    clusterAnalysis: { value: null, confidence: 'unavailable' as Confidence, evidence: 'Holder-cluster / insider-concentration analysis is built for Solana tokens only — no Base equivalent exists yet.' },
    eventCount: whaleRows.length,
    dataSource: whaleRows.length > 0
      ? `${whaleRows.length} tracked whale-alert event(s) for this contract (Pro/Elite whale monitoring feed).`
      : 'No tracked whale-alert events found for this contract in the monitored window — this does not mean no large trades happened, only that none were captured by the whale monitor.',
  }
  gap('New-wallet buyer count unavailable — this system does not currently classify buyer wallets as "new" vs. "existing" for Base tokens.')

  const riskAnalysis: RiskFactor[] = []
  const honeypot = pick<boolean>(tokenAnalysis, ['honeypot', 'isHoneypot']) ?? pick<boolean>(tokenAnalysis, ['honeypot'])
  const sellTax = pick<number>(tokenAnalysis, ['sellTax'])
  const buyTax = pick<number>(tokenAnalysis, ['buyTax'])
  riskAnalysis.push({
    label: 'Liquidity removable',
    status: lpLockStatus === 'locked' || lpLockStatus === 'burned' ? 'clear' : lpLockStatus === 'unlocked' ? 'confirmed' : 'unknown',
    confidence: (pick<string>(lpRisk, ['confidence']) as Confidence) ?? 'unavailable',
    evidence: lpLockStatus ? `LP status: ${lpLockStatus}.` : 'LP lock status did not resolve.',
    impact: lpLockStatus === 'unlocked' ? 'high' : 'medium',
  })
  riskAnalysis.push({
    label: 'Holder concentration',
    status: marketStructure.top10HolderPercent != null ? (marketStructure.top10HolderPercent > 50 ? 'confirmed' : 'clear') : 'unknown',
    confidence: marketStructure.top10HolderPercent != null ? 'high' : 'unavailable',
    evidence: marketStructure.top10HolderPercent != null ? `Top 10 holders control ${marketStructure.top10HolderPercent.toFixed(1)}% of supply.` : 'Holder distribution did not resolve.',
    impact: 'medium',
  })
  riskAnalysis.push({
    label: 'Honeypot / sell-blocking',
    status: honeypot === true ? 'confirmed' : honeypot === false ? 'clear' : 'unknown',
    confidence: honeypot != null ? 'high' : 'unavailable',
    evidence: honeypot != null ? `honeypot.is simulation: ${honeypot ? 'sell blocked' : 'sell succeeded'}.` : 'Honeypot simulation did not complete.',
    impact: 'high',
  })
  if (buyTax != null || sellTax != null) {
    riskAnalysis.push({
      label: 'Tax risk',
      status: (sellTax ?? 0) > 10 || (buyTax ?? 0) > 10 ? 'confirmed' : 'clear',
      confidence: 'high',
      evidence: `Buy tax ${buyTax ?? 0}%, sell tax ${sellTax ?? 0}% (simulated).`,
      impact: (sellTax ?? 0) > 10 ? 'high' : 'low',
    })
  } else {
    riskAnalysis.push({ label: 'Tax risk', status: 'unknown', confidence: 'unavailable', evidence: 'Buy/sell tax simulation did not resolve.', impact: 'medium' })
  }
  const sniperCount = pick<number>(sniperActivity, ['signalCount']) ?? pick<number>(sniperActivity, ['count'])
  const sniperDetected = pick<boolean>(sniperActivity, ['detected'])
  riskAnalysis.push({
    label: 'Snipers',
    status: sniperDetected === true ? 'confirmed' : sniperDetected === false ? 'clear' : 'unknown',
    confidence: sniperDetected != null ? 'medium' : 'unavailable',
    evidence: pick<string>(sniperActivity, ['reason']) ?? (sniperCount != null ? `${sniperCount} sniper signal(s) detected from abnormal early transaction volume.` : 'Sniper analysis did not resolve.'),
    impact: sniperDetected === true ? 'medium' : 'low',
  })
  riskAnalysis.push({ label: 'Creator selling', status: 'unsupported', confidence: 'unavailable', evidence: `Creator wallet resolution is not available for ${chainTokenLabel(chain)} tokens — cannot confirm or rule out creator-wallet sells.`, impact: 'medium' })
  riskAnalysis.push({ label: 'Wash trading', status: 'unsupported', confidence: 'unavailable', evidence: 'Wash-trading detection is not implemented for any chain in this system.', impact: 'medium' })
  riskAnalysis.push({ label: 'Bundle activity', status: 'unsupported', confidence: 'unavailable', evidence: 'Bundle-buy detection is not implemented in this system.', impact: 'low' })
  riskAnalysis.push({ label: 'Bot activity', status: 'unsupported', confidence: 'unavailable', evidence: 'Bot-trading detection is not implemented in this system.', impact: 'low' })
  const mintStatus = pick<string>(tokenAnalysis, ['ownerStatus'])
  riskAnalysis.push({
    label: 'Mint / owner risk',
    status: mintStatus === 'renounced' ? 'clear' : mintStatus ? 'possible' : 'unknown',
    confidence: mintStatus ? 'high' : 'unavailable',
    evidence: mintStatus ? `Contract owner status: ${mintStatus}.` : 'Owner/renounce status did not resolve.',
    impact: 'medium',
  })

  const killSignals: KillSignal[] = []
  if (whaleSells.length > 0) {
    killSignals.push({ label: 'Whale distribution', probability: whaleSells.length >= whaleBuys.length ? 'high' : 'medium', evidence: `${whaleSells.length} tracked whale sell(s) observed.` })
  } else {
    killSignals.push({ label: 'Whale distribution', probability: 'unknown', evidence: 'No tracked whale sells observed yet — absence of evidence, not evidence of absence, since only monitored wallets are captured.' })
  }
  killSignals.push({
    label: 'Liquidity removal',
    probability: lpLockStatus === 'unlocked' ? 'high' : lpLockStatus === 'locked' || lpLockStatus === 'burned' ? 'low' : 'unknown',
    evidence: lpLockStatus ? `LP status: ${lpLockStatus}.` : 'LP lock status did not resolve.',
  })
  killSignals.push({
    label: 'Holder concentration unwind',
    probability: marketStructure.top10HolderPercent != null ? (marketStructure.top10HolderPercent > 50 ? 'high' : 'low') : 'unknown',
    evidence: marketStructure.top10HolderPercent != null ? `Top 10 hold ${marketStructure.top10HolderPercent.toFixed(1)}% of supply.` : 'Holder distribution did not resolve.',
  })
  killSignals.push({
    label: 'Buy pressure fading',
    probability: buySellRatio != null ? (buySellRatio < 1 ? 'high' : 'low') : 'unknown',
    evidence: buySellRatio != null ? `Current buy/sell ratio ${buySellRatio.toFixed(2)}:1.` : 'Real-time transaction split did not resolve.',
  })
  killSignals.push({ label: 'Creator sell', probability: 'unknown', evidence: `Creator wallet is not resolvable for ${chainTokenLabel(chain)} tokens in this system.` })

  const continuationSignals: ContinuationSignal[] = [
    { label: 'Liquidity secured (locked/burned)', status: lpLockStatus === 'locked' || lpLockStatus === 'burned' ? true : lpLockStatus ? false : null, detail: lpLockStatus ? `LP status: ${lpLockStatus}.` : 'Unresolved.' },
    { label: 'Buys outpacing sells (24h)', status: buySellRatio != null ? buySellRatio > 1 : null, detail: buySellRatio != null ? `${buySellRatio.toFixed(2)}:1 ratio.` : 'Unresolved.' },
    { label: 'Volume expanding', status: (alert.volume24hUsd ?? 0) >= 100_000 ? true : (alert.volume24hUsd != null ? false : null), detail: alert.volume24hUsd != null ? `$${Math.round(alert.volume24hUsd).toLocaleString()} 24h volume.` : 'Unresolved.' },
    { label: 'Whale accumulation present', status: whaleRows.length > 0 ? whaleBuys.length > whaleSells.length : null, detail: whaleRows.length > 0 ? `${whaleBuys.length} buy(s) vs ${whaleSells.length} sell(s) tracked.` : 'No tracked whale activity for this contract.' },
    { label: 'Healthy holder distribution (top 10 < 50%)', status: marketStructure.top10HolderPercent != null ? marketStructure.top10HolderPercent < 50 : null, detail: marketStructure.top10HolderPercent != null ? `${marketStructure.top10HolderPercent.toFixed(1)}%.` : 'Unresolved.' },
    { label: 'Not flagged as honeypot', status: honeypot != null ? !honeypot : null, detail: honeypot != null ? (honeypot ? 'Flagged.' : 'Sell simulation passed.') : 'Unresolved.' },
  ]

  const historicalSimilarity = {
    available: false as const,
    reason: 'No table in this system stores past pump outcomes (peak price, retrace depth, lifespan) to compare against. This section requires new data collection over time before it can be built honestly — showing a fabricated comparison would violate the no-fabrication rule this report is held to.',
  }
  gap('Historical Similarity is not available — no pump-outcome history is collected anywhere in this system yet.')

  const watchlist: WatchItem[] = [
    { label: 'Watch LP changes', threshold: lpLockStatus === 'unlocked' ? 'LP is unlocked — any large LP removal is a direct rug signal' : 'Any change from locked/burned to unlocked' },
    { label: 'Watch whale wallets', threshold: whaleRows.length > 0 ? `${new Set(whaleRows.map(r => r.wallet_address)).size} distinct tracked wallet(s) — watch for a shift from buy to sell` : 'No wallets currently tracked for this contract' },
    { label: 'Watch sell pressure', threshold: 'Buy/sell ratio dropping below 1:1' },
    { label: 'Watch volume', threshold: '24h volume dropping below current level by >50%' },
    { label: 'Watch holder concentration', threshold: marketStructure.top10HolderPercent != null ? `Top 10 holder % rising above ${Math.ceil(marketStructure.top10HolderPercent)}%` : 'Not resolvable — no live holder-concentration polling configured' },
  ]

  const timeline: TimelineEvent[] = []
  if (pairCreatedAtIso) timeline.push({ timestamp: pairCreatedAtIso, label: 'Pool created', kind: 'pool_created' })
  for (const r of whaleRows) {
    timeline.push({
      timestamp: r.occurred_at,
      label: `${r.side === 'sell' ? 'Whale sold' : 'Whale bought'} — ${r.wallet_address.slice(0, 6)}…${r.wallet_address.slice(-4)}${r.amount_usd != null ? ` ($${Math.round(r.amount_usd).toLocaleString()})` : ''}`,
      kind: r.side === 'sell' ? 'whale_sell' : 'whale_buy',
    })
  }
  timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  if (timeline.length <= (pairCreatedAtIso ? 1 : 0)) gap('Timeline is sparse — only pool creation and tracked whale events are captured; no LP-change or holder-count event log exists yet.')

  return {
    contract: alert.contract, chain, symbol: alert.symbol, name: alert.name, generatedAt: new Date().toISOString(),
    executiveSummary: {
      momentumScore, momentumConfidence, momentumEvidence: momentumEvidenceNote,
      continuationScore, continuationProbability, continuationEvidence,
      pullbackRiskScore, pullbackRisk, pullbackEvidence, confidenceScore, overallConfidence, verdict,
    },
    catalysts, marketStructure, reportMarket, walletIntelligence, riskAnalysis, killSignals, continuationSignals,
    historicalSimilarity, watchlist, timeline: timeline.slice(0, 30), evidenceGaps,
    dataResolutionAudit: {
      tokenAddress: alert.contract, chainSlug: chain, pairAddress: alert.pairAddress ?? null,
      openedFromAlert: true, alertPayloadReceived: true,
      fieldsFromAlertPayload: [
        alert.priceUsd != null && 'priceUsd', alert.change24h != null && 'change24h',
        alert.change6h != null && 'change6h', alert.change1h != null && 'change1h',
        alert.change7d != null && 'change7d', alert.volume24hUsd != null && 'volume24hUsd',
        alert.liquidityUsd != null && 'liquidityUsd', alert.fdvUsd != null && 'fdvUsd',
        alert.marketCapUsd != null && 'marketCapUsd', alert.tokenAgeDays != null && 'tokenAgeDays',
        alert.pairAddress != null && 'pairAddress', alert.evidenceGrade != null && 'evidenceGrade',
      ].filter((v): v is string => typeof v === 'string'),
      dexScreenerAttempted, dexScreenerSucceeded,
      dexScreenerFieldsResolved: [txnsSource === 'dexscreener' && 'buys24h/sells24h'].filter((v): v is string => typeof v === 'string'),
      geckoTerminalAttempted: tokenAnalysis != null || poolActivity != null,
      geckoTerminalSucceeded: poolActivity != null,
      geckoFieldsResolved: [gtBuys24h != null && 'buys24h', gtSells24h != null && 'sells24h', pairCreatedAtIso != null && 'pairCreatedAt'].filter((v): v is string => typeof v === 'string'),
      snapshotsAttempted, snapshotsSucceeded, tokenScannerAttempted,
      tokenScannerSucceeded: tokenAnalysis != null,
      tokenScannerFieldsResolved: [rugRiskScore != null && 'rugRiskScore', holderCount != null && 'holderCount', marketCapUsd != null && 'marketCapUsd', honeypotResolved && 'honeypot'].filter((v): v is string => typeof v === 'string'),
      whaleDataAttempted, whaleDataSucceeded: whaleRows.length > 0,
      computedMomentumScore: momentumScore,
      computedContinuationProbability: continuationProbability === 'unavailable' ? null : continuationProbability,
      computedPullbackRisk: pullbackRisk === 'unavailable' ? null : pullbackRisk,
      unavailableFields: evidenceGaps.map(g => g.split(' unavailable')[0]).filter((v, i, arr) => arr.indexOf(v) === i),
      unavailableReasons: evidenceGaps,
    },
    marketDataAudit: {
      tokenAddress: alert.contract, chainSlug: chain, pairAddress: alert.pairAddress ?? null,
      openedFromAlert: true,
      alertPayloadFields: [alert.marketCapUsd != null && 'marketCapUsd', alert.fdvUsd != null && 'fdvUsd', alert.liquidityUsd != null && 'liquidityUsd', alert.volume24hUsd != null && 'volume24hUsd'].filter((v): v is string => typeof v === 'string'),
      dexScreenerAttempted, dexScreenerSucceeded,
      dexScreenerMarketCap: dexScreenerMarket?.marketCapUsd ?? null,
      dexScreenerFdv: dexScreenerMarket?.fdvUsd ?? null,
      dexScreenerTxnsAvailable: dexScreenerMarket?.buys24h != null && dexScreenerMarket?.sells24h != null,
      geckoAttempted: tokenScannerAttempted, geckoSucceeded: tokenAnalysis != null,
      tokenScannerAttempted, tokenScannerSucceeded: tokenAnalysis != null,
      resolvedMarketCapUsd: marketCapUsd, marketCapSource, resolvedFdvUsd: fdvUsd, fdvSource,
      resolvedBuys24h: buys24h, resolvedSells24h: sells24h, resolvedTxns24h: txns24h,
      unavailableFields: [marketCapUsd == null && 'marketCapUsd', txnsSource === 'none' && 'buys24h/sells24h', change7dOrExact == null && 'priceChange7d'].filter((v): v is string => typeof v === 'string'),
      unavailableReasons: [marketCapUnavailableReason, txnsUnavailableReason, change7dOrExact == null ? 'Exact 7d/14d change did not resolve from GeckoTerminal OHLCV or internal snapshots.' : null].filter((v): v is string => typeof v === 'string'),
    },
    pumpReportEvidenceAudit: {
      tokenAddress: alert.contract, chainSlug: chain,
      seedUsed: alert.evidenceGrade != null || alert.priceUsd != null || alert.change24h != null,
      sourcesAttempted: [
        'alert_payload',
        dexScreenerAttempted && 'dexscreener',
        (tokenAnalysis != null || poolActivity != null) && 'geckoterminal',
        tokenScannerAttempted && 'token_scanner',
        holderProviderAttempted && 'goldrush',
        snapshotsAttempted && 'internal_snapshot',
      ].filter((v): v is string => typeof v === 'string'),
      sourcesSucceeded: [
        'alert_payload',
        dexScreenerSucceeded && 'dexscreener',
        poolActivity != null && 'geckoterminal',
        tokenAnalysis != null && 'token_scanner',
        holderProviderSucceeded && 'goldrush',
        snapshotsSucceeded && 'internal_snapshot',
      ].filter((v): v is string => typeof v === 'string'),
      marketCapSource, fdvSource, liquiditySource,
      volumeSource: alert.volume24hUsd != null ? 'alert_payload' : 'none',
      ageSource: pairCreatedAtIso ? 'geckoterminal' : dexScreenerPairAgeHours != null ? 'dexscreener' : alert.tokenAgeDays != null ? 'alert_payload' : 'none',
      txnSplitSource: txnsSource,
      holderSource,
      securitySource: honeypotResolved ? 'token_scanner' : 'none',
      unavailableFields: [
        marketCapUsd == null && 'marketCapUsd', txnsSource === 'none' && 'buys24h/sells24h',
        holderCount == null && 'holderCount', !honeypotResolved && 'tokenSecurity',
      ].filter((v): v is string => typeof v === 'string'),
      unavailableReasons: [marketCapUnavailableReason, txnsUnavailableReason, holderUnavailableReason].filter((v): v is string => typeof v === 'string'),
      confidenceInputs,
      finalConfidence: overallConfidence,
    },
  }
}
