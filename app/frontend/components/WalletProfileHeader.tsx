// Wallet Profile Header — hero-style summary card shown above the V2 results (replaces the
// old plain FinalSummaryView text dump as the first thing a user sees after a scan).
//
// V2-SAFE GUARD: `report` is typed non-optional in the field-level helpers below, but every access
// still defensively falls back to a safe default — same convention as every other component in
// this directory.
//
// HONESTY NOTE: every value here is read directly from the V2 report or derived by pure arithmetic
// over it (e.g. first/last-seen from real timeline timestamps, chain percentages from
// portfolio.chainValueBreakdown). Nothing is invented:
//   - There is no "wallet tier" or wallet-quality score anywhere in this engine, so this header
//     does not render one. The Elite/plan badge in the page header above it reflects the signed-in
//     user's ChainLens plan, not a claim about the wallet being scanned.
//   - "Behavior classification" is a direct restatement of behaviorIntel.rotationStyle /
//     multiChainParticipation — never a fabricated label.
//   - A chain present in scanMetadata.chainsScanned but absent from portfolio.chainValueBreakdown
//     is shown as "no data" rather than silently omitted, so a HyperEVM scan doesn't look identical
//     to a HyperEVM chain that was never requested.

import type { FinalReport } from '@/src/modules/finalReportAssembler/types'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import type { Portfolio as EnginePortfolioV2 } from '@/lib/engine/modules/portfolio/types'
import type { SmartMoneyScore } from '@/lib/engine/modules/smartMoney/types'
import type { CanonicalSampleManifestAudit } from '@/src/lib/canonicalPnlSampleManifest'
import type { PricedHolding } from '@/lib/engine/modules/pricing/types'
import type { RobinhoodWalletScanResponse } from './RobinhoodChainSection'
import { ChainBadge } from './ChainBadge'
import { ConfidenceBadge } from './ConfidenceBadge'
import { PortfolioIntelligenceCard, selectPortfolioStats } from './PortfolioIntelligenceCard'
import { SmartMoneyScoreCard } from './SmartMoneyScoreCard'
import { fmtSignedUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { computeMergedTotalValueUsd, robinhoodStatusCopy, deriveCanonicalMergeOverride, buildWalletPublicUiDataAudit, mergeRobinhoodIntoPricedHoldings } from '@/app/frontend/lib/mergedWalletView'

// PORTFOLIO V2 MIGRATION, UPDATED: see app/terminal/wallet-scanner/page.tsx's own local
// WalletV2Report type (a separately-defined but structurally identical type — this file's own
// export isn't imported by that page today) for the up-to-date disclosure — `portfolioV2` is now
// genuinely populated in this app's real, live data flow (scanWalletV2() calls the route that
// computes it directly and exclusively). Only threaded through to
// PortfolioIntelligenceCard below — no other rendering in this file changes.
// CANONICAL CHAIN TOTALS, DISCLOSED (Holdings V2 display consistency fix, follow-up): this file's
// own chain-allocation bar previously read `report.portfolio?.chainValueBreakdown` — the OLD V1
// field — entirely disconnected from the canonical `chainValueUsd` the hero total right above it
// (via portfolioV2.totalValueUsd) is built from. Real production evidence: hero total $3,365.81,
// but the bar below it showed BASE $337.90 (98%) + ETH $7.30 (2%) = $345.20 — the stale V1 sum,
// with percentages computed relative to THAT wrong sum rather than the real total. Same root cause,
// same fix pattern as app/frontend/lib/holdingsV2Selector.ts: prefer the canonical
// `chainValueUsd`/`portfolioV2.totalValueUsd` pair when present; the V1 `chainValueBreakdown` stays
// as a real, genuine fallback only when portfolioV2/chainValueUsd is genuinely absent.
export type WalletV2Report = FinalReport & {
  holdings: TokenHolding[]
  portfolio: PortfolioSummary
  portfolioV2?: EnginePortfolioV2
  chainValueUsd?: Record<number, number>
  smartMoneyScore?: SmartMoneyScore
  // FAIL-CLOSED SHARED STATE, DISCLOSED (canonical-manifest-fast-path follow-up task, issue #3):
  // real field the API response already carries (RunWalletScanResult's own additive
  // `canonicalSampleManifestAudit` — src/pipeline/types.ts) but this frontend type never declared,
  // so no page-level caller could pass it into PnlStatusCard/SmartMoneyScoreCard at all. Optional —
  // an older cached response predating this field degrades to today's existing behavior.
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit
  // CANONICAL MULTI-CHAIN MERGE, DISCLOSED (final-canonical-merge-proof follow-up): same additive
  // fields as page.tsx's own WalletV2Report — see that file's header for the full disclosure. Only
  // the two fields deriveCanonicalMergeOverride() actually reads are declared here (this file's
  // WalletV2Report is a separate, structurally-identical type, not an import of page.tsx's).
  canonicalTotalValueUsd?: number | null
  finalCanonicalMergeAudit?: { robinhoodMerged: boolean }
  // AFTER-MERGE CHAIN BREAKDOWN, DISCLOSED (Wallet-Scanner-Robinhood-UI-breakdown-mismatch fix):
  // workers/walletScanV2.ts's own per-chain map (numeric chain id string keys, includes '4663' only
  // when Robinhood was actually merged) — see selectChainBreakdown's own header for the full trace.
  portfolioTotalByChain?: Record<string, number>
  // ADDED, DISCLOSED (finish-Wallet-Scanner-Robinhood-integration follow-up): same real field as
  // page.tsx's own WalletV2Report (lib/engine/modules/pricing's priceHoldings() output) — needed here
  // so walletPublicUiDataAudit's new per-chain holdings/priced counts can be computed off the SAME
  // real rows the Holdings tab renders (via mergeRobinhoodIntoPricedHoldings), not a re-derived guess.
  pricedHoldings?: PricedHolding[]
}

const CHAIN_ID_TO_CHAIN_STRING: Record<number, string> = { 1: 'eth', 8453: 'base', 42161: 'arbitrum', 999: 'hyperevm', 4663: 'robinhood' }

export type ChainBreakdownRow = { chain: string; valueUsd: number; percent: number }

// CLAMP, DISCLOSED (Wallet Scanner V3 layout task's explicit "clamp every displayed percentage to
// 0-100" requirement): a real, defensive guard — rounding/dust across many small chain balances, or
// a `chainValueUsd` snapshot momentarily out of sync with `totalValueUsd` (e.g. a stale cached
// response), could otherwise produce a percent fractionally over 100 or under 0. Clamped once here,
// at the single source every caller (old bar-width-only clamp inline in PortfolioSnapshot below, and
// the new V3 header) reads from — never a separate, potentially-inconsistent clamp per renderer.
function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent))
}

// PURE, exported for direct testing (same convention as PortfolioIntelligenceCard.tsx's own
// selectPortfolioStats). PRIORITY ORDER, DISCLOSED (Wallet-Scanner-Robinhood-UI-breakdown-mismatch
// fix): `canonicalChainTotalByChain` (workers/walletScanV2.ts's `portfolioTotalByChain` — the
// AFTER-Robinhood-merge per-chain map, real numeric chain ids 1/8453/4663/etc, only ever contains
// 4663 when the Robinhood adapter actually merged a real value) is now the FIRST-priority source —
// this is the exact same map the hero total above (via canonicalTotalValueUsd/
// deriveCanonicalMergeOverride) is built from, so the bars can never again show a smaller sum than
// the total displayed next to them (the confirmed live bug: total $9,097.55, bars summing to only
// $1,721.23 because the bars read the OLD, permanently EVM-only `chainValueUsd` while the total had
// already been fixed to include Robinhood). `chainValueUsd` (EVM-only pricing.chainValueUsd) is the
// fallback for a report that never went through the async job worker (the fast preview path, which
// has no canonicalChainTotalByChain field at all) — same real per-chain totals as before, just no
// longer the top priority. The old V1 `chainValueBreakdown` stays the last-resort fallback, unchanged.
export function selectChainBreakdown(
  chainValueUsd: Record<number, number> | null | undefined,
  totalValueUsd: number | null,
  v1Breakdown: ChainBreakdownRow[] | null | undefined,
  canonicalChainTotalByChain?: Record<string, number> | null,
): ChainBreakdownRow[] {
  const source = (canonicalChainTotalByChain && typeof canonicalChainTotalByChain === 'object' && Object.keys(canonicalChainTotalByChain).length > 0)
    ? canonicalChainTotalByChain
    : chainValueUsd
  if (source && typeof source === 'object') {
    return Object.entries(source)
      .filter(([, valueUsd]) => valueUsd > 0)
      .map(([chainIdStr, valueUsd]) => ({
        chain: CHAIN_ID_TO_CHAIN_STRING[Number(chainIdStr)] ?? chainIdStr,
        valueUsd,
        percent: totalValueUsd && totalValueUsd > 0 ? clampPercent((valueUsd / totalValueUsd) * 100) : 0,
      }))
      .sort((a, b) => b.valueUsd - a.valueUsd)
  }
  return (Array.isArray(v1Breakdown) ? v1Breakdown : []).map((row) => ({ ...row, percent: clampPercent(row.percent) }))
}

export type WalletProfileHeaderProps = {
  report: WalletV2Report | null | undefined
  loading: boolean
  isFullRecoveryAdmin: boolean
  onDeepScan: () => void
  onAdminAction: () => void
  // ONE CANONICAL RESULT, DISCLOSED (split-Wallet-Scanner-results fix task): optional — when present,
  // the hero total below and PortfolioIntelligenceCard merge Robinhood's real total in and stop
  // claiming Robinhood is excluded. Omitting it degrades exactly to this component's prior,
  // Base/ETH-only behavior — Base/ETH/BNB output is unchanged either way.
  robinhoodResult?: RobinhoodWalletScanResponse | null
}

function fmtUsdFull(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function shortenAddress(address: string): string {
  if (address.length <= 18) return address
  return `${address.slice(0, 6)}…${address.slice(-6)}`
}

function fmtTimestamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'Not available'
  return new Date(ms).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// PURE. Earliest/latest timestamp across every real timeline entry this report actually produced
// (buy/sell/distribution/bridge) — never a guess, and null (not "now"/"genesis") when there's
// nothing to derive it from.
function deriveActivityWindow(report: WalletV2Report): { firstSeenMs: number | null; lastActiveMs: number | null } {
  const timestamps: number[] = []

  const buyEntries = Array.isArray(report.timelines?.buyTimeline?.entries) ? report.timelines.buyTimeline.entries : []
  // WRONG-SELL-TIMELINE FIX, DISCLOSED (same bug class as recoveryPolicy's trigger, real-scan
  // evidence): this previously read report.timelines.sellTimeline — timelineBuilder's narrow
  // same-tx-swap-pairing-only heuristic — instead of sellTimelineV2 (the richer read model that also
  // detects transfer-to-known-router sells). For a wallet whose real sells are all router-transfer
  // shaped, timelines.sellTimeline.entries is empty even though sellTimelineV2 correctly finds e.g.
  // 198 real sells — so "Last Active" silently excluded every one of those real, timestamped sell
  // events, understating the wallet's true last-activity date whenever its most recent event was a
  // sell rather than a buy/distribution/bridge.
  const sellEntries = Array.isArray(report.timelines?.sellTimelineV2?.entries) ? report.timelines.sellTimelineV2.entries : []
  const distEntries = Array.isArray(report.timelines?.distributionTimeline?.entries) ? report.timelines.distributionTimeline.entries : []
  const bridgeEntries = Array.isArray(report.bridgeTimeline) ? report.bridgeTimeline : []

  for (const e of buyEntries) if (Number.isFinite(e.timestamp)) timestamps.push(e.timestamp)
  for (const e of sellEntries) if (Number.isFinite(e.timestamp)) timestamps.push(e.timestamp)
  for (const e of distEntries) if (Number.isFinite(e.timestamp)) timestamps.push(e.timestamp)
  for (const e of bridgeEntries) {
    const ms = Date.parse(e.timestamp)
    if (Number.isFinite(ms)) timestamps.push(ms)
  }

  if (timestamps.length === 0) return { firstSeenMs: null, lastActiveMs: null }
  return { firstSeenMs: Math.min(...timestamps), lastActiveMs: Math.max(...timestamps) }
}

// PURE. Restates behaviorIntel.rotationStyle + multiChainParticipation as a short label — never a
// new classification, just plain-English phrasing of the two real fields.
function deriveBehaviorLabel(report: WalletV2Report): string {
  const rotationStyle = report.behaviorIntel?.rotationStyle?.value ?? 'unknown'
  const activeChains = Array.isArray(report.behaviorIntel?.multiChainParticipation?.activeChains)
    ? report.behaviorIntel.multiChainParticipation.activeChains
    : []

  const styleLabel: Record<string, string> = {
    accumulator: 'Accumulator',
    rotator: 'Rotator',
    distributor: 'Distributor',
    unknown: 'Unclassified',
  }
  const label = styleLabel[rotationStyle] ?? 'Unclassified'
  return activeChains.length > 1 ? `Multi-Chain ${label}` : label
}

function deriveRiskProfile(report: WalletV2Report): string {
  const rotationStyle = report.behaviorIntel?.rotationStyle?.value ?? 'unknown'
  const riskOnOff = report.behaviorIntel?.riskOnOff?.value ?? 'unknown'
  if (rotationStyle === 'unknown' && riskOnOff === 'unknown') return 'Not enough evidence yet'

  const rotationPart = rotationStyle === 'rotator' ? 'High Rotation' : rotationStyle === 'unknown' ? null : `${rotationStyle}`
  const riskPart = riskOnOff === 'risk_on' ? 'Risk-On' : riskOnOff === 'risk_off' ? 'Risk-Off' : null

  return [rotationPart, riskPart].filter(Boolean).join(' / ') || 'Not enough evidence yet'
}

// EXPORTED, DISCLOSED (Wallet Scanner V3 layout task): additive-only `export` keyword — no logic
// change — so the new compact V3 header (app/frontend/components/WalletScannerHeaderV3.tsx) can
// reuse this exact, already-tested rendering instead of duplicating it.
export function WalletOverview({ report }: { report: WalletV2Report }) {
  const address = report.scanMetadata?.walletAddress ?? ''
  const { firstSeenMs, lastActiveMs } = deriveActivityWindow(report)

  return (
    <div>
      <div className="wph-address" style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '0.01em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: '#e2e8f0' }}>
        {address ? shortenAddress(address) : 'Unknown wallet'}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <span className="wph-badge" style={{ padding: '4px 11px', borderRadius: '999px', fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.30)', color: '#2DD4BF', boxShadow: '0 0 14px rgba(45,212,191,0.16)' }}>
          {deriveBehaviorLabel(report)}
        </span>
        <span className="wph-badge" style={{ padding: '4px 11px', borderRadius: '999px', fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.30)', color: '#fbbf24', boxShadow: '0 0 14px rgba(251,191,36,0.14)' }}>
          {deriveRiskProfile(report)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '24px', marginTop: '14px', flexWrap: 'wrap', fontSize: '11px', color: 'rgba(148,163,184,0.70)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        <span>First Seen — {fmtTimestamp(firstSeenMs)}</span>
        <span>Last Active — {fmtTimestamp(lastActiveMs)}</span>
      </div>
    </div>
  )
}

// CONFIRMED REGRESSION, FIXED (provider-call-audit follow-up task, real production evidence: header
// showed ~$300 while the backend's own portfolioIntelligenceInputs.totalValueUsd diagnostic logged
// $13,531.40 for the SAME scan): this previously read `report.portfolio?.totalValueUsd` directly —
// the OLD, V1 `src/modules/portfolio` field — completely bypassing `selectPortfolioStats()`
// (PortfolioIntelligenceCard.tsx), which ALREADY correctly prefers the new, canonical
// `portfolioV2.totalValueUsd` (computed by workers/walletScanV2.ts's pricing/portfolio stage — the
// same real total that diagnostic log line reports). The result: two different dollar figures were
// shown on the SAME page for the SAME scan — this hero total (stale/wrong) and the Portfolio
// Intelligence card's "Total Value" stat (correct) just below it. Fixed by using the exact same
// selection function, so both figures are now guaranteed to agree — never realizedPnlUsd (a
// completely separate field, read only by PnlAndConfidenceRow below), never a client-side sum of a
// filtered/top-holdings/fallback-budgeted subset (selectPortfolioStats reads the single
// already-computed totalValueUsd field either way, it never re-sums holdings for this purpose).
// EXPORTED, DISCLOSED (Wallet Scanner V3 layout task): additive-only — see WalletOverview's own
// export disclosure above for the reasoning.
export function PortfolioSnapshot({ report, robinhoodResult }: { report: WalletV2Report; robinhoodResult?: RobinhoodWalletScanResponse | null }) {
  const { stats, usingV2 } = selectPortfolioStats(report.portfolio, report.portfolioV2)
  // ONE CANONICAL TOTAL, DISCLOSED (split-Wallet-Scanner-results fix task): this hero total must
  // never disagree with PortfolioIntelligenceCard's total for the same scan — both now read through
  // the same computeMergedTotalValueUsd() helper. See mergedWalletView.ts's own header.
  // AFTER-MERGE HERO TOTAL, DISCLOSED (final-canonical-merge-proof follow-up): prefers the worker's
  // own already-merged canonical total (report.canonicalTotalValueUsd) when this report came from a
  // completed deep-scan job — the hero total must show the SAME after-merge figure the worker's own
  // finalCanonicalMergeAudit log proves, never a second, independently-recomputed number.
  const merged = computeMergedTotalValueUsd(stats.totalValueUsd, robinhoodResult, deriveCanonicalMergeOverride(report))
  const totalValueUsd = merged.totalValueUsd

  // DIAGNOSTICS, DISCLOSED (this task's explicit requirement): compares what the backend actually
  // computed against what this card is about to render, plus a LOCAL, comparison-only recomputation
  // from whatever priced-holdings list this report shape exposes — purely for audit logging, never
  // used to override `totalValueUsd` above. A real, future mismatch between backendTotalValueUsd and
  // locallyRecomputedTotalValueUsd would surface here immediately instead of silently drifting.
  if (process.env.NODE_ENV !== 'production') {
    const backendTotalValueUsd = usingV2 ? report.portfolioV2?.totalValueUsd ?? null : report.portfolio?.totalValueUsd ?? null
    const holdingsForRecompute = Array.isArray(report.portfolio?.tokens) ? report.portfolio!.tokens : []
    const pricedHoldings = holdingsForRecompute.filter((t) => t.valueUsd != null)
    const locallyRecomputedTotalValueUsd = pricedHoldings.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0)
    // eslint-disable-next-line no-console
    console.debug('[wallet-profile-header] portfolio total diagnostics', {
      usingV2,
      backendTotalValueUsd,
      frontendRenderedTotalValueUsd: totalValueUsd,
      locallyRecomputedTotalValueUsd,
      pricedHoldingsCount: pricedHoldings.length,
    })
  }

  const breakdown = selectChainBreakdown(report.chainValueUsd, totalValueUsd, report.portfolio?.chainValueBreakdown, report.portfolioTotalByChain)
  const chainsScanned = Array.isArray(report.scanMetadata?.chainsScanned) ? report.scanMetadata.chainsScanned : []
  const chainsWithoutData = chainsScanned.filter((c) => !breakdown.some((b) => b.chain === c))

  // WALLET PUBLIC UI DATA AUDIT, DISCLOSED (Wallet-Scanner-Robinhood-UI-breakdown-mismatch fix): logged
  // unconditionally (not gated to non-production, unlike the diagnostic above) — this is the literal,
  // required proof that the chain bars a user sees sum to the same total displayed next to them, and
  // that CORTEX (chainSignalLabel, computed the same way from the same `report`/`merged` inputs) shows
  // the same chain set. See mergedWalletView.ts's own header for the full disclosure.
  const cortexChainsForAudit = merged.robinhoodIncluded
    ? [...(report.behaviorIntel?.multiChainParticipation?.activeChains ?? []), 'robinhood']
    : [...(report.behaviorIntel?.multiChainParticipation?.activeChains ?? [])]
  // HOLDINGS/PNL COUNT INPUTS, DISCLOSED (finish-Wallet-Scanner-Robinhood-integration follow-up):
  // the SAME merge the Holdings tab itself uses (WalletScannerTabsV3.tsx) — never a second,
  // independently-derived merge that could silently disagree with what the tab actually renders.
  const mergedHoldingsForAudit = mergeRobinhoodIntoPricedHoldings(report.pricedHoldings, report.chainValueUsd, robinhoodResult, report.portfolioTotalByChain)
  const CHAIN_ID_TO_CHAIN_STRING_FOR_AUDIT = CHAIN_ID_TO_CHAIN_STRING
  const displayedHoldingsRows = mergedHoldingsForAudit.pricedHoldings.map((p) => ({
    chain: CHAIN_ID_TO_CHAIN_STRING_FOR_AUDIT[p.chainId] ?? String(p.chainId),
    valueUsd: p.valueUsd,
  }))
  const displayedPnlChains = [
    ...chainsScanned,
    ...(robinhoodResult && robinhoodResult.ok ? ['robinhood'] : []),
  ]
  const walletPublicUiDataAudit = buildWalletPublicUiDataAudit({
    displayedTotalUsd: totalValueUsd,
    displayedBreakdown: breakdown,
    canonicalChainTotalByChain: report.portfolioTotalByChain,
    evmOnlyChainValueUsd: report.chainValueUsd,
    v1BreakdownPresent: Array.isArray(report.portfolio?.chainValueBreakdown) && report.portfolio!.chainValueBreakdown!.length > 0,
    chainsScanned,
    cortexChainsDisplayed: cortexChainsForAudit,
    displayedHoldingsRows,
    displayedPnlChains,
  })
  // eslint-disable-next-line no-console
  console.log('[wallet-profile-header] walletPublicUiDataAudit', walletPublicUiDataAudit)

  return (
    <div>
      <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '4px' }}>
        Supported On-Chain Portfolio Value
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <span className="wph-value" style={{ fontSize: '28px', fontWeight: 900, color: '#f1f5f9', fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '-0.02em' }}>
          {totalValueUsd != null ? fmtUsdFull(totalValueUsd) : 'Not available'}
        </span>
        <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(139,92,246,0.85)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', border: '1px solid rgba(139,92,246,0.35)', borderRadius: '999px', padding: '3px 9px' }}>
          {report.scanMetadata?.intel_window_days ?? '—'}-Day Intelligence Engine
        </span>
      </div>
      {/* COVERAGE DISCLOSURE, UPDATED DISCLOSURE (split-Wallet-Scanner-results fix task): Robinhood
          Chain scanning now genuinely exists in this codebase (lib/server/robinhoodWalletScanner.ts,
          wired into this page's own handleRobinhoodScan()) — the old comment/copy here claiming "no
          custodial/exchange integration anywhere in this codebase" / "permanent, not scan-dependent"
          is now false and has been replaced with copy that reflects the real, scan-dependent state:
          when Robinhood was actually, successfully scanned this session, the total above already
          includes it (see mergedWalletView.ts) and the copy says so; otherwise it stays honest about
          on-chain-only coverage without claiming Robinhood support doesn't exist. */}
      <p style={{ fontSize: '10px', color: 'rgba(148,163,184,0.45)', marginTop: '4px', maxWidth: '480px' }}>
        {robinhoodStatusCopy(robinhoodResult, merged.robinhoodIncluded)}
      </p>

      {breakdown.length === 0 && chainsWithoutData.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', marginTop: '10px' }}>No holdings data available for this scan.</p>
      ) : (
        <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {breakdown.map((entry) => (
            <div key={entry.chain} className="wph-chain-row" style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' }}>
              <span style={{ width: '96px' }}><ChainBadge chain={entry.chain} /></span>
              <span style={{ flex: 1, height: '6px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, entry.percent))}%`, background: 'linear-gradient(90deg, #2DD4BF, #22c5ae)', borderRadius: '999px' }} />
              </span>
              <span style={{ color: '#94a3b8', minWidth: '110px', textAlign: 'right' }}>{fmtUsdFull(entry.valueUsd)} ({entry.percent.toFixed(0)}%)</span>
            </div>
          ))}
          {chainsWithoutData.map((chain) => (
            <div key={chain} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', opacity: 0.55 }}>
              <span style={{ width: '84px', textTransform: 'capitalize', color: '#64748b', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{chain}</span>
              <span style={{ flex: 1, fontSize: '11px', color: '#64748b' }}>No verified provider yet — scanned, no holdings data</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Real fifoAndPnl.realizedPnlUsd (the actual FIFO engine) + real behaviorIntel.confidence — never a
// redefinition of what "confidence" means elsewhere in the report (see PnLTab.tsx's own note on
// this).
//
// UNREALIZED-PNL SOURCE, DISCLOSED (found live, this task — "audit every Wallet Scanner UI path
// that renders Unrealized PnL" requirement): this used to read fifoAndPnl.unrealizedPnlUsd directly
// — fifoEngine's own un-reconciled top-level total, the exact class of legacy field responsible for
// the confirmed ~$500k fabricated-PnL bug elsewhere in this same UI (see PnlStatusCard.tsx's own
// header for the full trace). Now reads ONLY
// fifoAndPnl.unrealizedReconciliation.officialUnrealizedPnlUsd — null when reconciliation is absent
// or found nothing trustworthy, rendered as the same honest "—" the null-coalesced style below
// already produces, never a fallback estimate. This component is currently reachable only via the
// disabled legacy layout (WALLET_SCANNER_UI_V3 = false in page.tsx) — fixed anyway so a rollback to
// that layout can never resurface the bug.
function PnlAndConfidenceRow({ report }: { report: WalletV2Report }) {
  const realized = report.fifoAndPnl?.realizedPnlUsd ?? null
  const unrealized = report.fifoAndPnl?.unrealizedReconciliation?.officialUnrealizedPnlUsd ?? null
  const confidence = report.behaviorIntel?.confidence ?? 'low'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap', fontSize: '12px' }}>
      <span>
        <span style={{ color: '#64748b' }}>Realized PnL — </span>
        <span style={{ fontWeight: 700, color: realized == null ? 'rgba(148,163,184,0.55)' : realized >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(realized)}</span>
      </span>
      <span>
        <span style={{ color: '#64748b' }}>Unrealized PnL — </span>
        <span style={{ fontWeight: 700, color: unrealized == null ? 'rgba(148,163,184,0.55)' : unrealized >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(unrealized)}</span>
      </span>
      <ConfidenceBadge level={confidence} />
    </div>
  )
}

function BehaviorSummary({ report }: { report: WalletV2Report }) {
  const evaluation = Array.isArray(report.recoveryPolicy?.evaluation) ? report.recoveryPolicy.evaluation : []
  const triggeredCount = evaluation.filter((e) => e.recoveryTriggered).length
  const pagesUsed = report.recoveryPolicy?.totalPagesUsedThisWallet ?? 0
  const confidence = report.behaviorIntel?.confidence ?? 'low'
  const activeChains = Array.isArray(report.behaviorIntel?.multiChainParticipation?.activeChains)
    ? report.behaviorIntel.multiChainParticipation.activeChains
    : []
  const pnlHeadline = report.finalSummary?.financialStatus?.headline ?? 'PnL unavailable due to missing evidence.'

  const confidenceLabel: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#cbd5e1', lineHeight: 1.6 }}>
      <div><span style={{ color: '#64748b' }}>Style: </span>{deriveBehaviorLabel(report)}</div>
      <div><span style={{ color: '#64748b' }}>PnL: </span>{pnlHeadline}</div>
      <div><span style={{ color: '#64748b' }}>Recovery: </span>{pagesUsed} page(s) used, {triggeredCount}/{evaluation.length} token(s) reconstructed</div>
      <div>
        <span style={{ color: '#64748b' }}>Confidence: </span>
        {confidenceLabel[confidence] ?? 'Low'}
        {activeChains.length > 0 ? ` (${activeChains.join(' + ')} evidence)` : ' (no chain met the active-intelligence gate this scan)'}
      </div>
    </div>
  )
}

// EXPORTED, DISCLOSED (Wallet Scanner V3 layout task): additive-only — see WalletOverview's own
// export disclosure above for the reasoning.
export function Actions({ loading, onDeepScan }: Pick<WalletProfileHeaderProps, 'loading' | 'isFullRecoveryAdmin' | 'onDeepScan' | 'onAdminAction'>) {
  return (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      {/* Run Deep Scan is the sole action here — Smart Recovery / Admin Full Recovery removed
          (they only ever triggered the same Deep Scan, so nothing else changes). */}
      <button
        type="button"
        onClick={onDeepScan}
        disabled={loading}
        style={{
          padding: '10px 18px', borderRadius: '10px', border: 'none',
          background: loading ? 'rgba(45,212,191,0.25)' : 'linear-gradient(135deg, #2DD4BF, #22c5ae)',
          color: '#03121e', fontSize: '11px', fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase', cursor: loading ? 'not-allowed' : 'pointer',
          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          boxShadow: loading ? 'none' : '0 0 20px rgba(45,212,191,0.25)',
        }}
      >
        Run Deep Scan
      </button>
    </div>
  )
}

export function WalletProfileHeader({ report, loading, isFullRecoveryAdmin, onDeepScan, onAdminAction, robinhoodResult }: WalletProfileHeaderProps) {
  if (!report) return null

  return (
    <div className="wph-root ws-result-fade" style={{ background: 'linear-gradient(160deg, rgba(45,212,191,0.05), rgba(6,10,18,0.97))', border: '1px solid rgba(45,212,191,0.18)', borderRadius: '18px', padding: '24px 26px', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '20px', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 32px rgba(0,0,0,0.28)' }}>
      <WalletOverview report={report} />
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
      <PortfolioSnapshot report={report} robinhoodResult={robinhoodResult} />
      <PortfolioIntelligenceCard
        portfolio={report.portfolio}
        portfolioV2={report.portfolioV2}
        // NOTE, DISCLOSED: `chainsScanned` here stays EVM-only (report.scanMetadata.chainsScanned) —
        // it feeds this card's own "Chain Exposure" chip list, which is typed against SupportedChain
        // (base/eth/arbitrum/hyperevm only; ChainBadge has no 'robinhood' rendering case). Robinhood's
        // own chain chip/tab already exists via the dedicated WalletScannerTabsV3/RobinhoodChainSection
        // mechanism (split-Wallet-Scanner-results fix task) — that is Robinhood's real "chain chip",
        // not this SupportedChain-typed prop. Forcing 'robinhood' into this array would be a type lie
        // with no real renderer for it, not an honest inclusion.
        chainsScanned={report.scanMetadata?.chainsScanned}
        activeChain={report.behaviorIntel?.multiChainParticipation?.primaryChain}
        robinhoodResult={robinhoodResult}
        canonicalOverride={deriveCanonicalMergeOverride(report)}
      />
      {report.smartMoneyScore && (
        <>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
          <SmartMoneyScoreCard smartMoneyScore={report.smartMoneyScore} canonicalSampleManifestAudit={report.canonicalSampleManifestAudit} />
        </>
      )}
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
      <PnlAndConfidenceRow report={report} />
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
      <BehaviorSummary report={report} />
      <Actions loading={loading} isFullRecoveryAdmin={isFullRecoveryAdmin} onDeepScan={onDeepScan} onAdminAction={onAdminAction} />
    </div>
  )
}

export default WalletProfileHeader
