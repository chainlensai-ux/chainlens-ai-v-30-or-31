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
    // Which real source resolved buys/sells — GeckoTerminal (via /api/token's poolActivity) is tried
    // first since it's already the authoritative source elsewhere in this app; DexScreener is the
    // fallback when that didn't resolve. 'none' when neither provider had it — never fabricated.
    txnsSource: 'geckoterminal' | 'dexscreener' | 'none'
    // RELIABLE-MARKET-CAP FIX, DISCLOSED: honest reason text shown when buys/sells never resolved —
    // "the provider simply lacks the field" vs "everything failed" are different situations.
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
    // RELIABLE-MARKET-CAP FIX, DISCLOSED (requested fallback order: alert payload → DexScreener
    // pair.marketCap → [FDV never substituted] → GeckoTerminal → Token Scanner → internal snapshot →
    // Unavailable). Never derived from FDV — a null here always means every real source came back
    // empty, tracked in marketCapUnavailableReason.
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

  // RELIABLE-MARKET-CAP FIX, DISCLOSED: the exact canonical object requested — a flat, single
  // source of truth for every market-evidence field, each with its own resolved source, so a
  // consumer never has to reverse-engineer which provider a number came from. marketStructure above
  // is kept for the existing UI wiring; reportMarket is additive, not a replacement.
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

  historicalSimilarity: {
    available: false
    reason: string
  }

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
  // 7d/14d change is the gate a token had to clear to be a Pump Alert at all, so the report must be
  // able to show the evidence it was selected on — not just the 24h move. Pump Alerts' real evidence
  // ladder produces a 14d figure (see pump14dEvidence.ts), so this carries either — the report shows
  // it honestly as "Exact 7d/14d unavailable" when neither resolved, never fabricated.
  change7d?: number | null
  // LIVE-EVIDENCE REPORT FIX, DISCLOSED (requested audit: "too many core fields show Unavailable").
  // The Pump Alert card already has 6h/1h change, market cap, pool age, pair address and evidence
  // mode — none of that reached this module before, so momentum/continuation/pullback had no signal
  // to compute from unless the internal /api/token CORTEX call happened to fully resolve. Seeding
  // these here lets the report compute real scores from the SAME evidence the card already showed,
  // with CORTEX data (when it resolves) layered on top as a confidence upgrade, not a hard requirement.
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

// RELIABLE-MARKET-CAP FIX, DISCLOSED: full DexScreener pair market evidence (not just buys/sells) —
// a second real provider for every field in the canonical ReportMarket object below, normalized
// straight from pair.priceUsd/marketCap/fdv/liquidity.usd/volume.{h24,h6,h1}/
// priceChange.{h24,h6,h1}/txns.{h24,h6,h1}/pairCreatedAt exactly per the requested provider mapping.
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

// RELIABLE-MARKET-CAP FIX, DISCLOSED: the exact canonical object requested — one normalized
// snapshot of every market-evidence field, each carrying its own resolved source so "where did this
// number come from" never requires cross-referencing three different objects.
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

// RELIABLE-MARKET-CAP FIX, DISCLOSED: exact shape requested — a market-data-specific companion to
// PumpReportDataResolutionAudit above, focused on exactly which provider resolved (or failed to
// resolve) each market-evidence field, so "why is Market Cap unavailable" is always answerable
// without cross-referencing the broader resolution audit.
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

// ─── Live-evidence scoring (requested audit: "core scores must compute whenever live market
// evidence exists, not just when the full CORTEX read resolves") ─────────────────────────────────
// Pure, deterministic composites of REAL inputs only — every term is gated on that input actually
// being present, so missing data contributes nothing (never treated as a zero or a penalty). These
// are always labeled 'live_estimate' evidence tier, distinct from a CORTEX-verified read, and never
// claim to be the same thing.
export type LiveScoreResult = { score: number | null; evidenceCount: number; parts: string[] }

export function chainTokenLabel(chain: string): string {
  const c = chain.toLowerCase()
  if (c === 'eth' || c === 'ethereum') return 'Ethereum'
  if (c === 'robinhood') return 'Robinhood Chain'
  if (c === 'base') return 'Base'
  return chain
}
