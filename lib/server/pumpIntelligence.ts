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
  status: 'confirmed' | 'possible' | 'clear' | 'unknown'
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
    buySellRatio: number | null
    liquidityUsd: number | null
    liquidityTrend: EvidenceItem<null>
    volume24hUsd: number | null
    holderCount: number | null
    holderCountCapped: boolean
    holderTrend: EvidenceItem<null>
    fdvUsd: number | null
    marketCapUsd: number | null
    ageHours: number | null
    priceChange24h: number | null
    priceChange7d: number | null
    top1HolderPercent: number | null
    top10HolderPercent: number | null
  }

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

  historicalSimilarity: {
    available: false
    reason: string
  }

  watchlist: WatchItem[]

  timeline: TimelineEvent[]

  evidenceGaps: string[]
}

export interface PumpAlertInput {
  symbol: string
  name: string
  contract: string
  priceUsd: number | null
  change24h: number | null
  // 7d change is the gate a token had to clear to be a Pump Alert at all, so the report must be
  // able to show the evidence it was selected on — not just the 24h move.
  change7d?: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  reason: string
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW'
}

// Minimal slice of /api/token's response this module actually reads — deliberately typed loose
// (Record<string, unknown> drill-down) since that route's real response type isn't exported and
// re-declaring its full shape here would be exactly the duplication this module exists to avoid.
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

export function buildPumpIntelligenceReport(params: {
  alert: PumpAlertInput
  chain: string
  tokenAnalysis: TokenAnalysisSlice | null
  whaleRows: WhaleAlertRow[]
  trackedAddresses: Set<string>
}): PumpIntelligenceReport {
  const { alert, chain, tokenAnalysis, whaleRows, trackedAddresses } = params
  const evidenceGaps: string[] = []
  const gap = (msg: string) => { evidenceGaps.push(msg) }

  const riskEngine = pick<Record<string, unknown>>(tokenAnalysis, ['riskEngine'])
  const poolActivity = pick<Record<string, unknown>>(tokenAnalysis, ['poolActivity'])
  const holderDistribution = pick<Record<string, unknown>>(tokenAnalysis, ['holderDistribution'])
  const holderResolver = pick<Record<string, unknown>>(tokenAnalysis, ['holderResolver'])
  const selectedPool = pick<Record<string, unknown>>(tokenAnalysis, ['selectedPool'])
  const holderIntelligence = pick<Record<string, unknown>>(riskEngine, ['holderIntelligence'])
  const smartMoney = pick<Record<string, unknown>>(riskEngine, ['smartMoney'])
  const deployerProfile = pick<Record<string, unknown>>(riskEngine, ['deployerProfile'])
  const sniperActivity = pick<Record<string, unknown>>(riskEngine, ['sniperActivity'])
  const trendIntelligence = pick<Record<string, unknown>>(riskEngine, ['trendIntelligence'])
  const lpIntelligence = pick<Record<string, unknown>>(riskEngine, ['lpIntelligence'])
  const lpRisk = pick<Record<string, unknown>>(riskEngine, ['lpRisk'])

  const buys24h = pick<number>(poolActivity, ['buys24h'])
  const sells24h = pick<number>(poolActivity, ['sells24h'])
  const pairCreatedAt = pick<string>(poolActivity, ['pairCreatedAt'])
  const ageHours = pairCreatedAt ? (Date.now() - new Date(pairCreatedAt).getTime()) / 3_600_000 : null
  const holderCount = pick<number>(holderResolver, ['holderCount']) ?? pick<number>(tokenAnalysis, ['holderCount'])
  const holderCountCapped = pick<boolean>(tokenAnalysis, ['holderCountCapped']) ?? false
  const marketCapUsd = pick<number>(tokenAnalysis, ['marketCap', 'value']) ?? pick<number>(tokenAnalysis, ['marketCapUsd'])

  const rugRiskScore = pick<number>(riskEngine, ['rugRiskScore'])
  const rugRiskLabel = pick<string>(riskEngine, ['rugRiskLabel'])
  const riskDrivers = pick<string[]>(riskEngine, ['riskDrivers']) ?? []
  const openChecks = pick<string[]>(riskEngine, ['openChecks']) ?? []
  const verifiedSignals = pick<string[]>(riskEngine, ['verifiedSignals']) ?? []
  const clarkInterpretation = pick<string>(riskEngine, ['clarkInterpretation'])

  // ── 1. Executive Summary ────────────────────────────────────────────────────────────────
  const buySellRatio = buys24h != null && sells24h != null && sells24h > 0 ? buys24h / sells24h : null
  const momentumScore = rugRiskScore != null ? Math.max(0, 100 - rugRiskScore) : null
  const continuationScore = buys24h != null && sells24h != null && buys24h + sells24h > 0
    ? Math.round((buys24h / (buys24h + sells24h)) * 100)
    : null
  const pullbackRiskScore = rugRiskScore ?? null
  if (rugRiskScore == null) gap('Momentum score unavailable — CORTEX risk read did not resolve for this token.')

  let continuationProbability: 'high' | 'medium' | 'low' | 'unavailable' = 'unavailable'
  let continuationEvidence = 'Insufficient verified signals to estimate continuation.'
  if (buySellRatio != null && lpRisk) {
    const lpConfidence = pick<string>(lpRisk, ['confidence'])
    if (buySellRatio > 1.3 && (lpConfidence === 'high' || lpConfidence === 'medium')) {
      continuationProbability = 'medium'
      continuationEvidence = `Buy/sell ratio is ${buySellRatio.toFixed(2)}:1 over 24h with ${lpConfidence}-confidence LP data — demand is currently outweighing supply, but this is a 24h snapshot, not a trend.`
    } else if (buySellRatio < 0.8) {
      continuationProbability = 'low'
      continuationEvidence = `Buy/sell ratio is ${buySellRatio.toFixed(2)}:1 over 24h — sell pressure currently exceeds buy pressure.`
    } else {
      continuationProbability = 'low'
      continuationEvidence = `Buy/sell ratio is ${buySellRatio.toFixed(2)}:1 — roughly balanced, no clear directional edge.`
    }
  } else {
    gap('Continuation probability unavailable — real-time buy/sell transaction counts did not resolve.')
  }

  let pullbackRisk: 'high' | 'medium' | 'low' | 'unavailable' = 'unavailable'
  let pullbackEvidence = 'Insufficient verified signals to estimate pullback risk.'
  if (rugRiskLabel) {
    pullbackRisk = rugRiskLabel === 'critical' || rugRiskLabel === 'high' ? 'high' : rugRiskLabel === 'watch' ? 'medium' : 'low'
    pullbackEvidence = clarkInterpretation ?? `CORTEX risk label: ${rugRiskLabel}.`
  } else {
    gap('Pullback risk unavailable — CORTEX risk read did not resolve.')
  }

  const overallConfidence: Confidence = tokenAnalysis == null ? 'unavailable'
    : (rugRiskLabel === 'partial_data' || openChecks.length > 3) ? 'low'
    : openChecks.length > 0 ? 'medium' : 'high'
  const confidenceChecks = [rugRiskScore != null, buySellRatio != null, lpRisk != null, holderDistribution != null, riskEngine != null]
  const confidenceScore = Math.round((confidenceChecks.filter(Boolean).length / confidenceChecks.length) * 100)

  const verdictParts: string[] = []
  verdictParts.push(`${alert.symbol} ${alert.reason.toLowerCase()}.`)
  if (buySellRatio != null) verdictParts.push(`Real-time transactions show a ${buySellRatio.toFixed(2)}:1 buy/sell ratio over 24h.`)
  if (riskDrivers.length > 0) verdictParts.push(`Key risk: ${riskDrivers[0]}.`)
  else if (verifiedSignals.length > 0) verdictParts.push(`Verified: ${verifiedSignals[0]}.`)
  if (tokenAnalysis == null) verdictParts.push('Full CORTEX analysis was unavailable for this token — this read is based on pump-detection signals only.')
  const verdict = verdictParts.join(' ')

  // ── 2. Why It Pumped (catalysts, ranked) ────────────────────────────────────────────────
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

  // ── 3. Market Structure ─────────────────────────────────────────────────────────────────
  const marketStructure = {
    buys24h,
    sells24h,
    buySellRatio,
    liquidityUsd: alert.liquidityUsd,
    liquidityTrend: { value: null, confidence: 'unavailable' as Confidence, evidence: 'Liquidity is only ever observed as a point-in-time snapshot — no historical liquidity series is stored anywhere in this system.' },
    volume24hUsd: alert.volume24hUsd,
    holderCount,
    holderCountCapped,
    holderTrend: { value: null, confidence: 'unavailable' as Confidence, evidence: 'Holder count is a live snapshot only — no polling job stores historical holder counts to compute growth.' },
    fdvUsd: alert.fdvUsd,
    marketCapUsd,
    ageHours,
    priceChange24h: alert.change24h,
    priceChange7d: alert.change7d ?? null,
    top1HolderPercent: pick<number>(holderDistribution, ['top1']),
    top10HolderPercent: pick<number>(holderDistribution, ['top10']),
  }
  if (holderCount == null) gap('Holder count unavailable for this token.')
  if (ageHours == null) gap('Pool age unavailable — pool creation timestamp did not resolve.')

  // ── 4. Wallet Intelligence ──────────────────────────────────────────────────────────────
  const toWalletRow = (r: WhaleAlertRow): WalletRow => ({
    address: r.wallet_address,
    side: r.side === 'sell' ? 'sell' : 'buy',
    amountUsd: r.amount_usd,
    occurredAt: r.occurred_at,
    isTracked: trackedAddresses.has(r.wallet_address.toLowerCase()),
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
    largestBuyers,
    largestSellers,
    netWhaleFlowUsd,
    newWalletBuyerCount: null as number | null,
    trackedWalletActivity,
    creatorActivity: { value: null, confidence: 'unavailable' as Confidence, evidence: 'Creator/deployer wallet resolution is built for Solana tokens only — no equivalent exists for Base tokens in this system yet.' },
    clusterAnalysis: { value: null, confidence: 'unavailable' as Confidence, evidence: 'Holder-cluster / insider-concentration analysis is built for Solana tokens only — no Base equivalent exists yet.' },
    eventCount: whaleRows.length,
    dataSource: whaleRows.length > 0
      ? `${whaleRows.length} tracked whale-alert event(s) for this contract (Pro/Elite whale monitoring feed).`
      : 'No tracked whale-alert events found for this contract in the monitored window — this does not mean no large trades happened, only that none were captured by the whale monitor.',
  }
  gap('New-wallet buyer count unavailable — this system does not currently classify buyer wallets as "new" vs. "existing" for Base tokens.')

  // ── 5. Risk Analysis ─────────────────────────────────────────────────────────────────────
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
  riskAnalysis.push({ label: 'Creator selling', status: 'unknown', confidence: 'unavailable', evidence: 'Creator wallet resolution is not available for Base tokens — cannot confirm or rule out creator-wallet sells.', impact: 'medium' })
  riskAnalysis.push({ label: 'Wash trading', status: 'unknown', confidence: 'unavailable', evidence: 'Wash-trading detection is not implemented for any chain in this system.', impact: 'medium' })
  riskAnalysis.push({ label: 'Bundle activity', status: 'unknown', confidence: 'unavailable', evidence: 'Bundle-buy detection is not implemented in this system.', impact: 'low' })
  riskAnalysis.push({ label: 'Bot activity', status: 'unknown', confidence: 'unavailable', evidence: 'Bot-trading detection is not implemented in this system.', impact: 'low' })
  const mintStatus = pick<string>(tokenAnalysis, ['ownerStatus'])
  riskAnalysis.push({
    label: 'Mint / owner risk',
    status: mintStatus === 'renounced' ? 'clear' : mintStatus ? 'possible' : 'unknown',
    confidence: mintStatus ? 'high' : 'unavailable',
    evidence: mintStatus ? `Contract owner status: ${mintStatus}.` : 'Owner/renounce status did not resolve.',
    impact: 'medium',
  })

  // ── 6. What Could Kill This Pump ────────────────────────────────────────────────────────
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
  killSignals.push({ label: 'Creator sell', probability: 'unknown', evidence: 'Creator wallet is not resolvable for Base tokens in this system.' })

  // ── 7. Continuation Signals (bullish checklist) ─────────────────────────────────────────
  const continuationSignals: ContinuationSignal[] = [
    { label: 'Liquidity secured (locked/burned)', status: lpLockStatus === 'locked' || lpLockStatus === 'burned' ? true : lpLockStatus ? false : null, detail: lpLockStatus ? `LP status: ${lpLockStatus}.` : 'Unresolved.' },
    { label: 'Buys outpacing sells (24h)', status: buySellRatio != null ? buySellRatio > 1 : null, detail: buySellRatio != null ? `${buySellRatio.toFixed(2)}:1 ratio.` : 'Unresolved.' },
    { label: 'Volume expanding', status: (alert.volume24hUsd ?? 0) >= 100_000 ? true : (alert.volume24hUsd != null ? false : null), detail: alert.volume24hUsd != null ? `$${Math.round(alert.volume24hUsd).toLocaleString()} 24h volume.` : 'Unresolved.' },
    { label: 'Whale accumulation present', status: whaleRows.length > 0 ? whaleBuys.length > whaleSells.length : null, detail: whaleRows.length > 0 ? `${whaleBuys.length} buy(s) vs ${whaleSells.length} sell(s) tracked.` : 'No tracked whale activity for this contract.' },
    { label: 'Healthy holder distribution (top 10 < 50%)', status: marketStructure.top10HolderPercent != null ? marketStructure.top10HolderPercent < 50 : null, detail: marketStructure.top10HolderPercent != null ? `${marketStructure.top10HolderPercent.toFixed(1)}%.` : 'Unresolved.' },
    { label: 'Not flagged as honeypot', status: honeypot != null ? !honeypot : null, detail: honeypot != null ? (honeypot ? 'Flagged.' : 'Sell simulation passed.') : 'Unresolved.' },
  ]

  // ── 8. Historical Similarity — genuinely unavailable ────────────────────────────────────
  const historicalSimilarity = {
    available: false as const,
    reason: 'No table in this system stores past pump outcomes (peak price, retrace depth, lifespan) to compare against. This section requires new data collection over time before it can be built honestly — showing a fabricated comparison would violate the no-fabrication rule this report is held to.',
  }
  gap('Historical Similarity is not available — no pump-outcome history is collected anywhere in this system yet.')

  // ── 9. Actionable Watchlist ──────────────────────────────────────────────────────────────
  const watchlist: WatchItem[] = [
    { label: 'Watch LP changes', threshold: lpLockStatus === 'unlocked' ? 'LP is unlocked — any large LP removal is a direct rug signal' : 'Any change from locked/burned to unlocked' },
    { label: 'Watch whale wallets', threshold: whaleRows.length > 0 ? `${new Set(whaleRows.map(r => r.wallet_address)).size} distinct tracked wallet(s) — watch for a shift from buy to sell` : 'No wallets currently tracked for this contract' },
    { label: 'Watch sell pressure', threshold: 'Buy/sell ratio dropping below 1:1' },
    { label: 'Watch volume', threshold: '24h volume dropping below current level by >50%' },
    { label: 'Watch holder concentration', threshold: marketStructure.top10HolderPercent != null ? `Top 10 holder % rising above ${Math.ceil(marketStructure.top10HolderPercent)}%` : 'Not resolvable — no live holder-concentration polling configured' },
  ]

  // ── 10. Timeline ──────────────────────────────────────────────────────────────────────────
  const timeline: TimelineEvent[] = []
  if (pairCreatedAt) timeline.push({ timestamp: pairCreatedAt, label: 'Pool created', kind: 'pool_created' })
  for (const r of whaleRows) {
    timeline.push({
      timestamp: r.occurred_at,
      label: `${r.side === 'sell' ? 'Whale sold' : 'Whale bought'} — ${r.wallet_address.slice(0, 6)}…${r.wallet_address.slice(-4)}${r.amount_usd != null ? ` ($${Math.round(r.amount_usd).toLocaleString()})` : ''}`,
      kind: r.side === 'sell' ? 'whale_sell' : 'whale_buy',
    })
  }
  timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  if (timeline.length <= (pairCreatedAt ? 1 : 0)) gap('Timeline is sparse — only pool creation and tracked whale events are captured; no LP-change or holder-count event log exists yet.')

  return {
    contract: alert.contract,
    chain,
    symbol: alert.symbol,
    name: alert.name,
    generatedAt: new Date().toISOString(),
    executiveSummary: {
      momentumScore,
      momentumConfidence: momentumScore != null ? 'medium' : 'unavailable',
      continuationScore,
      continuationProbability,
      continuationEvidence,
      pullbackRiskScore,
      pullbackRisk,
      pullbackEvidence,
      confidenceScore,
      overallConfidence,
      verdict,
    },
    catalysts,
    marketStructure,
    walletIntelligence,
    riskAnalysis,
    killSignals,
    continuationSignals,
    historicalSimilarity,
    watchlist,
    timeline: timeline.slice(0, 30),
    evidenceGaps,
  }
}
