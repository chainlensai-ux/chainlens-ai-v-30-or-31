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
  // UNSUPPORTED-VS-UNKNOWN FIX, DISCLOSED (requested: "If unsupported, label as 'Unsupported on this
  // chain/provider' instead of generic Unknown"). 'unknown' means this token's own data COULD exist
  // but didn't resolve this read (worth retrying); 'unsupported' means no resolver exists anywhere in
  // this system for this chain/module at all (retrying never helps) — collapsing both into "Unknown"
  // hid that distinction from the reader.
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
