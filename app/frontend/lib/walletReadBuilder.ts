// WALLET READ BUILDER, DISCLOSED (Wallet Read / CORTEX sidebar redesign task).
//
// ROLE, DISCLOSED: the single pure builder behind the "CORTEX · Wallet Read" sidebar
// (app/frontend/components/WalletReadPanel.tsx renders whatever this returns). Every field here is
// either a direct read of an already-computed, real value or a template built from real counts —
// never a new judgment, never an LLM-style paraphrase, never a number invented to fill a bullet.
//
// SAME SELECTORS AS THE MAIN UI, DISCLOSED (this task's own explicit hard rule — "Use the same
// underlying selectors/data as the main Wallet Scanner so sidebar and main view cannot disagree"):
// this function takes its inputs ALREADY COMPUTED by the exact selectors the main Wallet Scanner
// result uses — selectPortfolioStats (PortfolioIntelligenceCard.tsx), selectChainBreakdown
// (WalletProfileHeader.tsx), selectEvmPnlLaneStatus/selectRobinhoodPnlLaneStatus/
// selectPnlConfidenceStatus (PnlStatusCard.tsx), computeMergedTotalValueUsd/
// computeRobinhoodDisplayState (mergedWalletView.ts) — never a second, independently-derived
// computation of any of these. The page-level call site (app/terminal/wallet-scanner/page.tsx)
// passes the SAME call results it already threads into the main UI's own components.
//
// FAIL-CLOSED ROBINHOOD PNL, DISCLOSED: `pnlLanes` below never shows a Robinhood realized PnL
// number unless `robinhoodPnlLane === 'verified'` — the same Phase-3-gated, verifiedSwapCount>0
// classification PnlStatusCard.tsx's own RobinhoodPnlRow uses. This function has no PnL math of its
// own; it only reads the already-classified lane status and a message.

import type { BehaviorIntelResult } from '@/src/modules/behaviorIntel/types'
import type { FinalSummary } from '@/src/modules/finalReportAssembler/types'
import type { RobinhoodWalletScanResponse } from '@/app/frontend/components/RobinhoodChainSection'
import type { ChainBreakdownRow } from '@/app/frontend/components/WalletProfileHeader'
import type { PnlConfidenceStatus, EvmPnlLaneStatus, RobinhoodPnlLaneStatus } from '@/app/frontend/components/PnlStatusCard'
import type { RobinhoodDisplayState } from '@/app/frontend/lib/mergedWalletView'
import { fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'

export type WalletReadConfidence = 'High' | 'Medium' | 'Low'

export type WalletReadIdentity = {
  shortAddress: string
  personalityLabel: string
  confidence: WalletReadConfidence
  dataFreshness: string
}

export type WalletReadKeySignal = { label: string; value: string }

export type WalletReadEvidenceState = 'verified' | 'partial' | 'missing'

export type WalletReadEvidence = {
  verified: string[]
  partial: string[]
  missing: string[]
}

export type WalletReadPnlLane = {
  chainLabel: string
  status: 'verified' | 'partial' | 'not_verified' | 'unavailable'
  statusLabel: string
  detail: string
}

export type WalletReadV2 = {
  identity: WalletReadIdentity
  headline: string
  keySignals: WalletReadKeySignal[]
  whyThisLabel: string[]
  evidence: WalletReadEvidence
  pnlLanes: WalletReadPnlLane[]
  nextAction: string
}

// CHAIN LABELS, DISCLOSED: presentation-only capitalization for the small, fixed set of real chain
// slugs this engine ever produces (see holdingsHeuristics.ts's own fmtChainLabel for the canonical
// version this mirrors) — kept local so this file has no React/JSX dependency and stays trivially
// importable from a plain Node test script.
const CHAIN_DISPLAY_LABEL: Record<string, string> = {
  eth: 'ETH', base: 'Base', arbitrum: 'Arbitrum', hyperevm: 'HyperEVM', bnb: 'BNB', robinhood: 'Robinhood',
}
function chainLabel(chain: string): string {
  return CHAIN_DISPLAY_LABEL[chain] ?? chain
}

function shortenAddress(address: string | null | undefined): string {
  if (!address) return 'Unknown wallet'
  if (address.length <= 14) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

// DATA FRESHNESS, DISCLOSED: a real elapsed-time computation off scanMetadata.scanTimestamp — never
// a guessed/rounded-up "just now" when the timestamp is missing or unparseable (falls back to an
// honest "Freshness unknown" instead).
export function computeDataFreshness(scanTimestamp: string | null | undefined, nowMs: number = Date.now()): string {
  if (!scanTimestamp) return 'Freshness unknown'
  const scannedMs = new Date(scanTimestamp).getTime()
  if (!Number.isFinite(scannedMs)) return 'Freshness unknown'
  const deltaMs = Math.max(0, nowMs - scannedMs)
  const deltaMin = Math.round(deltaMs / 60_000)
  if (deltaMin < 1) return 'Scanned just now'
  if (deltaMin < 60) return `Scanned ${deltaMin}m ago`
  const deltaHr = Math.round(deltaMin / 60)
  if (deltaHr < 24) return `Scanned ${deltaHr}h ago`
  const deltaDay = Math.round(deltaHr / 24)
  return `Scanned ${deltaDay}d ago`
}

// CONFIDENCE BADGE, DISCLOSED: a direct passthrough of behaviorIntel.confidence (ConfidenceLevel —
// already a real, server-computed classification, see behaviorIntel/types.ts) — never re-derived
// or upgraded here. Absent behaviorIntel is honestly 'Low', never defaulted to 'Medium'/'High'.
export function selectWalletReadConfidence(behaviorIntel: BehaviorIntelResult | null | undefined): WalletReadConfidence {
  const level = behaviorIntel?.confidence
  if (level === 'high') return 'High'
  if (level === 'medium') return 'Medium'
  return 'Low'
}

// PERSONALITY LABEL, DISCLOSED: built ONLY from real, already-computed behaviorIntel fields —
// rotationStyle.value (accumulator/rotator/distributor/unknown) and concentrationSignals (real
// concentration label). 'unknown' rotation with no concentration signal honestly falls back to a
// neutral 'Wallet' label rather than guessing a personality with zero supporting evidence — the
// hard rule "if a label is shown, provide supporting bullets" means a label with nothing behind it
// must not be shown as a specific personality at all.
export function selectPersonalityLabel(behaviorIntel: BehaviorIntelResult | null | undefined): string {
  const rotation = behaviorIntel?.rotationStyle?.value ?? 'unknown'
  const isMultiChain = (behaviorIntel?.multiChainParticipation?.activeChains?.length ?? 0) > 1
  const concentrationLabel = behaviorIntel?.concentrationSignals?.concentrationLabel ?? null

  if (rotation === 'unknown') {
    if (concentrationLabel === 'high') return isMultiChain ? 'Multi-chain Concentrated Holder' : 'Concentrated Holder'
    return 'Wallet'
  }
  const base = rotation === 'rotator' ? 'Rotator' : rotation === 'distributor' ? 'Distributor' : 'Accumulator'
  if (rotation === 'accumulator' && concentrationLabel === 'high') return isMultiChain ? 'Multi-chain Concentrated Holder' : 'Concentrated Holder'
  return isMultiChain ? `Multi-chain ${base}` : base
}

function fmtMedianGap(medianMsBetweenSells: number | null | undefined): string | null {
  if (medianMsBetweenSells == null) return null
  const days = medianMsBetweenSells / 86_400_000
  if (days < 1) return `${Math.round(medianMsBetweenSells / 3_600_000)}h`
  return `${days.toFixed(1)}d`
}

// HEADLINE, DISCLOSED: exactly 1-2 sentences, built from real classification fields only — no
// paraphrasing, no "appears to"/"seems to"/"overall" filler (this task's own explicit ban). Sentence
// 1 states the label + chain breadth + Robinhood dominance (only when the real top chain IS
// Robinhood, never assumed); sentence 2 states the real PnL evidence lane state — never a specific
// unverified number.
export function buildHeadline(params: {
  personalityLabel: string
  activeChainCount: number
  topChain: ChainBreakdownRow | null
  evmPnlLane: EvmPnlLaneStatus
}): string {
  const { personalityLabel, activeChainCount, topChain, evmPnlLane } = params
  const robinhoodDominant = topChain?.chain === 'robinhood' && topChain.percent >= 50
  const chainClause = activeChainCount > 1 ? ` across ${activeChainCount} chains` : ''
  const robinhoodClause = robinhoodDominant ? ' with heavy Robinhood exposure' : ''
  const sentence1 = `${personalityLabel}${chainClause}${robinhoodClause}.`

  const sentence2 = evmPnlLane === 'verified'
    ? 'Verified PnL evidence is available for the on-chain lane.'
    : evmPnlLane === 'partial'
      ? 'Official performance is not yet fully rateable — verified closed-history coverage is bounded.'
      : 'No verified PnL evidence yet for this wallet.'

  return `${sentence1} ${sentence2}`
}

// KEY SIGNALS, DISCLOSED: every value is a direct read or simple arithmetic off already-computed
// fields — no new fetch, no new classification. Buys/sells and holding-style are OMITTED entirely
// (never shown as 0/unknown placeholders) when the backing evidence genuinely doesn't exist, per
// this task's own "Buys / sells if available" / "only if backed by metrics" wording.
export function buildKeySignals(params: {
  chainsScanned: string[]
  robinhoodIncluded: boolean
  totalValueUsd: number | null
  topChain: ChainBreakdownRow | null
  pricedTokenCount: number
  lastActiveMs: number | null
  buyCount: number | null
  sellCount: number | null
  rotationStyle: string | null
}): WalletReadKeySignal[] {
  const signals: WalletReadKeySignal[] = []
  const chains = [...params.chainsScanned.map(chainLabel), ...(params.robinhoodIncluded ? ['Robinhood'] : [])]
  signals.push({ label: 'Chains active', value: chains.length > 0 ? chains.join(', ') : 'None' })
  signals.push({ label: 'Portfolio value', value: params.totalValueUsd != null ? fmtUsd(params.totalValueUsd) : 'Not available' })
  if (params.topChain) {
    signals.push({ label: 'Largest chain exposure', value: `${chainLabel(params.topChain.chain)} · ${params.topChain.percent.toFixed(0)}%` })
  }
  signals.push({ label: 'Priced tokens', value: String(params.pricedTokenCount) })
  signals.push({
    label: 'Last active',
    value: params.lastActiveMs != null ? new Date(params.lastActiveMs).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown',
  })
  if (params.buyCount != null && params.sellCount != null && (params.buyCount > 0 || params.sellCount > 0)) {
    signals.push({ label: 'Buys / sells', value: `${params.buyCount} / ${params.sellCount}` })
  }
  if (params.rotationStyle && params.rotationStyle !== 'unknown') {
    signals.push({ label: 'Rotation style', value: params.rotationStyle })
  }
  return signals
}

// WHY THIS LABEL, DISCLOSED (this task's own explicit hard rule — "If a label is shown, provide
// supporting bullets"): 3-5 bullets, each built from a real, already-computed field, each only
// included when its backing number is real (non-null, non-zero where zero would be meaningless).
// Never pads to a target count with a filler line.
export function buildWhyThisLabel(params: {
  topChain: ChainBreakdownRow | null
  matchedLotsCount: number
  medianSellGap: string | null
  concentrationDetail: string | null
  historicalCoverage: string | null
}): string[] {
  const bullets: string[] = []
  if (params.topChain && params.topChain.percent >= 50) {
    bullets.push(`${params.topChain.percent.toFixed(0)}% of supported value is on ${chainLabel(params.topChain.chain)}${params.topChain.chain === 'robinhood' ? ' Chain' : ''}`)
  }
  if (params.matchedLotsCount > 0) {
    bullets.push(`${params.matchedLotsCount} verified trade${params.matchedLotsCount === 1 ? '' : 's'} found`)
  }
  if (params.medianSellGap) {
    bullets.push(`Median gap between sells: ${params.medianSellGap}`)
  }
  if (params.concentrationDetail) {
    bullets.push(`Top holding concentration: ${params.concentrationDetail}`)
  }
  if (params.historicalCoverage && params.historicalCoverage !== 'Not available') {
    bullets.push(`Closed-history coverage: ${params.historicalCoverage}`)
  }
  return bullets.slice(0, 5)
}

// EVIDENCE, DISCLOSED: reuses selectPnlConfidenceStatus's already-computed realized/unrealized/
// historicalCoverage classification (PnlStatusCard.tsx) plus the real robinhoodDisplayState/
// robinhoodPnlLane — never a second, independently-derived verified/partial/missing judgment.
// Holdings/chain-exposure are always 'verified' here because they are the same real, already-priced
// pricedHoldings/chainValueUsd rows the Holdings tab renders — no gate exists for those beyond "the
// scan returned real priced data", which the caller already confirmed by having a totalValueUsd.
export function buildEvidence(params: {
  hasHoldingsData: boolean
  pnlConfidence: PnlConfidenceStatus
  robinhoodDisplayState: RobinhoodDisplayState
  robinhoodPnlLane: RobinhoodPnlLaneStatus
  matchedLotsCount: number
}): WalletReadEvidence {
  const verified: string[] = []
  const partial: string[] = []
  const missing: string[] = []

  if (params.hasHoldingsData) verified.push('Holdings and chain exposure')
  if (params.robinhoodDisplayState === 'valued' || params.robinhoodDisplayState === 'partial_unpriced') verified.push('Robinhood holdings scan')
  if (params.matchedLotsCount > 0) verified.push('Closed-lot sample')

  if (params.pnlConfidence.realized === 'Partial') partial.push('Realized PnL (bounded sample)')
  if (params.pnlConfidence.unrealized === 'Partial') partial.push('Unrealized/open-position PnL')
  if (params.robinhoodPnlLane === 'not_verified') partial.push('Robinhood PnL (real evidence, not fully verified)')

  if (params.pnlConfidence.realized === 'Locked') missing.push('Realized PnL')
  if (params.pnlConfidence.unrealized === 'Unavailable') missing.push('Unrealized PnL')
  if (params.pnlConfidence.historicalCoverage === 'Not available') missing.push('Full historical coverage')
  if (params.robinhoodPnlLane === 'unavailable') missing.push('Robinhood PnL')

  return { verified, partial, missing }
}

// PNL LANES, DISCLOSED (this task's own explicit hard rule — "never merge them", "if Robinhood is
// not verified, say exactly why"): two independent lane entries, Base/ETH and Robinhood (only when
// a real robinhoodResult exists) — never a single blended status or number. The exact reason string
// for a not-verified Robinhood lane matches this task's own required wording verbatim.
export const ROBINHOOD_PNL_NOT_VERIFIED_REASON = 'Requires verified Robinhood swaps + both-leg price evidence.'

export function buildPnlLanes(params: {
  evmPnlLane: EvmPnlLaneStatus
  robinhoodPnlLane: RobinhoodPnlLaneStatus
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined
}): WalletReadPnlLane[] {
  const lanes: WalletReadPnlLane[] = [{
    chainLabel: 'Base/ETH',
    status: params.evmPnlLane,
    statusLabel: params.evmPnlLane === 'verified' ? 'Verified' : params.evmPnlLane === 'partial' ? 'Partial' : 'Unavailable',
    detail: params.evmPnlLane === 'verified'
      ? 'Verified closed-lot sample.'
      : params.evmPnlLane === 'partial'
        ? 'Bounded or magnitude-flagged sample — not a full-history verified figure.'
        : 'No verified PnL evidence for this lane.',
  }]

  if (params.robinhoodResult) {
    const verified = params.robinhoodPnlLane === 'verified'
    lanes.push({
      chainLabel: 'Robinhood',
      status: params.robinhoodPnlLane,
      statusLabel: verified ? 'Verified' : params.robinhoodPnlLane === 'not_verified' ? 'Not verified' : 'Unavailable',
      detail: verified
        ? `${params.robinhoodResult.pnl.verifiedSwapCount} verified swap${params.robinhoodResult.pnl.verifiedSwapCount === 1 ? '' : 's'} — realized PnL is a real, gated figure.`
        : ROBINHOOD_PNL_NOT_VERIFIED_REASON,
    })
  }

  return lanes
}

// NEXT ACTION, DISCLOSED: ONE short, real, prioritized action — never a generic "explore the
// dashboard" filler. Priority: a genuinely bounded/partial EVM PnL sample first (the single most
// common real gap), then an unverified-but-present Robinhood lane, then a high-concentration risk
// flag, then a neutral fallback for a fully-verified/well-covered wallet.
export function buildNextAction(params: {
  evmPnlLane: EvmPnlLaneStatus
  robinhoodPnlLane: RobinhoodPnlLaneStatus
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined
  concentrationLabel: string | null
}): string {
  if (params.evmPnlLane === 'partial') return 'Run Deep Scan to improve verified history coverage.'
  if (params.robinhoodResult && params.robinhoodPnlLane === 'not_verified') return 'Inspect the Robinhood tab for verified swap evidence.'
  if (params.concentrationLabel === 'high') return 'Review concentration risk in top holdings.'
  if (params.evmPnlLane === 'unavailable') return 'Run Deep Scan to build a verifiable PnL sample.'
  return 'No further action needed — evidence coverage is strong.'
}

// TOP-LEVEL BUILDER, DISCLOSED: composes every section above from the SAME already-computed inputs
// the caller (page.tsx) also feeds into the main Wallet Scanner UI's own components — see this
// file's own header for the full "same selectors" disclosure. Returns null only when there is no
// real scan at all (mirrors the pre-existing buildCortexReadV2's own null-when-no-report contract).
export function buildWalletReadV2(params: {
  walletAddress: string | null | undefined
  scanTimestamp: string | null | undefined
  chainsScanned: string[]
  behaviorIntel: BehaviorIntelResult | null | undefined
  finalSummary: FinalSummary | null | undefined
  totalValueUsd: number | null
  robinhoodIncluded: boolean
  chainBreakdown: ChainBreakdownRow[]
  pricedTokenCount: number
  concentrationDetail: string | null
  concentrationLabel: string | null
  matchedLotsCount: number
  lastActiveMs: number | null
  evmPnlLane: EvmPnlLaneStatus
  robinhoodPnlLane: RobinhoodPnlLaneStatus
  robinhoodDisplayState: RobinhoodDisplayState
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined
  pnlConfidence: PnlConfidenceStatus
}): WalletReadV2 {
  const topChain = params.chainBreakdown.length > 0
    ? [...params.chainBreakdown].sort((a, b) => b.percent - a.percent)[0]
    : null
  const personalityLabel = selectPersonalityLabel(params.behaviorIntel)
  const activeChainCount = params.chainsScanned.length + (params.robinhoodIncluded ? 1 : 0)
  const medianSellGap = fmtMedianGap(params.behaviorIntel?.exitVelocity?.medianMsBetweenSells)
  const buyCount = params.behaviorIntel?.rotationStyle?.basis?.buyCount ?? null
  const sellCount = params.behaviorIntel?.rotationStyle?.basis?.sellCount ?? null
  const rotationStyle = params.behaviorIntel?.rotationStyle?.value ?? null

  return {
    identity: {
      shortAddress: shortenAddress(params.walletAddress),
      personalityLabel,
      confidence: selectWalletReadConfidence(params.behaviorIntel),
      dataFreshness: computeDataFreshness(params.scanTimestamp),
    },
    headline: buildHeadline({ personalityLabel, activeChainCount, topChain, evmPnlLane: params.evmPnlLane }),
    keySignals: buildKeySignals({
      chainsScanned: params.chainsScanned,
      robinhoodIncluded: params.robinhoodIncluded,
      totalValueUsd: params.totalValueUsd,
      topChain,
      pricedTokenCount: params.pricedTokenCount,
      lastActiveMs: params.lastActiveMs,
      buyCount,
      sellCount,
      rotationStyle,
    }),
    whyThisLabel: buildWhyThisLabel({
      topChain,
      matchedLotsCount: params.matchedLotsCount,
      medianSellGap,
      concentrationDetail: params.concentrationDetail,
      historicalCoverage: params.pnlConfidence.historicalCoverage,
    }),
    evidence: buildEvidence({
      hasHoldingsData: params.totalValueUsd != null,
      pnlConfidence: params.pnlConfidence,
      robinhoodDisplayState: params.robinhoodDisplayState,
      robinhoodPnlLane: params.robinhoodPnlLane,
      matchedLotsCount: params.matchedLotsCount,
    }),
    pnlLanes: buildPnlLanes({ evmPnlLane: params.evmPnlLane, robinhoodPnlLane: params.robinhoodPnlLane, robinhoodResult: params.robinhoodResult }),
    nextAction: buildNextAction({
      evmPnlLane: params.evmPnlLane,
      robinhoodPnlLane: params.robinhoodPnlLane,
      robinhoodResult: params.robinhoodResult,
      concentrationLabel: params.concentrationLabel,
    }),
  }
}
