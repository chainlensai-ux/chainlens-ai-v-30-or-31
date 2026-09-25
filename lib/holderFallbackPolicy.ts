// TOKEN SCANNER HOLDER FALLBACK POLICY — DISCLOSED.
// Public holder evidence (Holder Map rows, Top-N, Stage 1 custody, Stage 2 ordinary concentration,
// Dev Control / cluster supply, CORTEX, risk) must describe CURRENT holdings.
//
// deriveHolderConcentrationFromTransfers replays a small transfer window (the earliest token
// transfers, fetched for deployer discovery). That is launch-era evidence, not current balances.
// Regression fixture: ASTEROID/ETH replayed its first 50 transfers into a public Top1 of 61.82%
// (pool) and Ordinary Top10 of 19.9% while the chain showed 3,546 holders and the pool at ~6.9%.
// Transfer-derived rows are therefore diagnostic-only and can never replace public holder rows.
//
// A holder COUNT is only a count when it is a provider total. A returned-row length is a sample
// size, never a holder count.

export type HolderCountReason =
  | 'holder_count_from_provider_total'
  | 'holder_count_from_normalized_rows'
  | 'holder_count_from_resolver'
  | 'holder_count_unavailable_with_reason'

export interface HolderCountSemantics {
  /** Provider-reported total only. Null when no provider total exists — never a row length. */
  holderCount: number | null
  holderCountReason: HolderCountReason
  holderCountExact: boolean
  /** True when only a partial row sample exists (no provider total). */
  holderCountCapped: boolean
}

export function resolveHolderCountSemantics(input: {
  providerTotal: number | null | undefined
  normalizedRows: number
  resolverRows: number
}): HolderCountSemantics {
  const total = typeof input.providerTotal === 'number' && Number.isFinite(input.providerTotal) && input.providerTotal > 0
    ? input.providerTotal
    : null
  if (total != null) {
    return { holderCount: total, holderCountReason: 'holder_count_from_provider_total', holderCountExact: true, holderCountCapped: false }
  }
  const reason: HolderCountReason = input.normalizedRows > 0
    ? 'holder_count_from_normalized_rows'
    : input.resolverRows > 0
      ? 'holder_count_from_resolver'
      : 'holder_count_unavailable_with_reason'
  return {
    holderCount: null,
    holderCountReason: reason,
    holderCountExact: false,
    holderCountCapped: reason !== 'holder_count_unavailable_with_reason',
  }
}

/** Reason emitted when current holder rows lack percentages and only launch-transfer evidence exists. */
export const TRANSFER_DERIVED_NOT_CURRENT_REASON = 'holder_percentages_unavailable_transfer_evidence_not_current'

export interface OverlayHolderRow {
  address: string
  percent: number | null
  balanceRaw?: string | null
  rank?: number | null
}

export interface OverlayHolderEvidence {
  holders: OverlayHolderRow[]
  holdersSource: string
  top1Pct: number | null
  top10Pct: number | null
  top20Pct: number | null
}

export interface PublicHolderRow {
  rank: number
  address: string
  amount: string | number | null
  percent: number | null
}

export interface PublicHolderDistributionLike<Row extends PublicHolderRow> {
  top1: number | null
  top10: number | null
  top20: number | null
  others: number | null
  topHolders: Row[]
}

export interface PublicHolderStatusLike {
  status: string
  reason: string
  itemCount: number
  normalizedCount: number
  percentSource: string
}

const hasUsablePercent = (rows: Array<{ percent: number | null }>) =>
  rows.some((h) => typeof h.percent === 'number' && Number.isFinite(h.percent))

/**
 * Decide what the dev-cluster overlay may contribute to PUBLIC holder evidence.
 * - transfer_derived rows/top-N: never. When current rows lack percentages, concentration stays
 *   unavailable/partial with TRANSFER_DERIVED_NOT_CURRENT_REASON.
 * - current-holder sources (goldrush/alchemy/blockscout/existing): unchanged prior behavior.
 */
export function mergeDevClusterOverlayHolders<
  Row extends PublicHolderRow,
  Dist extends PublicHolderDistributionLike<Row>,
  Status extends PublicHolderStatusLike,
>(input: {
  holderRows: Row[]
  holderDistribution: Dist
  holderDistributionStatus: Status
  overlay: OverlayHolderEvidence
  transferDerivedAvailable?: boolean
}): { holderRows: Row[]; holderDistribution: Dist; holderDistributionStatus: Status; transferDerivedRejected: boolean } {
  const { overlay } = input
  let { holderRows, holderDistribution, holderDistributionStatus } = input
  const havePct = hasUsablePercent(holderRows)
  const overlayIsTransferDerived = overlay.holdersSource === 'transfer_derived'

  if (overlayIsTransferDerived || (input.transferDerivedAvailable && !hasUsablePercent(overlay.holders))) {
    if (!havePct) {
      holderDistributionStatus = {
        ...holderDistributionStatus,
        status: holderDistributionStatus.status === 'ok' ? 'partial' : holderDistributionStatus.status,
        reason: TRANSFER_DERIVED_NOT_CURRENT_REASON,
      }
    }
    return { holderRows, holderDistribution, holderDistributionStatus, transferDerivedRejected: true }
  }

  if (overlay.holders.length > 0) {
    if (!havePct) {
      holderRows = overlay.holders.map((h, i) => ({
        rank: h.rank ?? i + 1,
        address: h.address,
        amount: h.balanceRaw ?? null,
        percent: h.percent,
      }) as Row)
      holderDistribution = {
        ...holderDistribution,
        top1: overlay.top1Pct ?? holderDistribution.top1,
        top10: overlay.top10Pct ?? holderDistribution.top10,
        top20: overlay.top20Pct ?? holderDistribution.top20,
        others: overlay.top20Pct != null ? Math.max(0, 100 - overlay.top20Pct) : holderDistribution.others,
        topHolders: holderRows,
      }
      holderDistributionStatus = {
        ...holderDistributionStatus,
        status: 'partial',
        reason: 'holder_percentages_from_dev_cluster_overlay',
        itemCount: Math.max(holderDistributionStatus.itemCount, overlay.holders.length),
        normalizedCount: holderRows.length,
      }
    } else if ((holderDistribution.top1 == null || holderDistribution.top10 == null) && overlay.top1Pct != null) {
      holderDistribution = {
        ...holderDistribution,
        top1: overlay.top1Pct,
        top10: overlay.top10Pct,
        top20: overlay.top20Pct,
        others: overlay.top20Pct != null ? Math.max(0, 100 - overlay.top20Pct) : holderDistribution.others,
      }
    }
  }
  return { holderRows, holderDistribution, holderDistributionStatus, transferDerivedRejected: false }
}

/** RPC totalSupply() hex/decimal to a decimal string for diagnostics; null when unusable. */
export function rpcSupplyToDecimal(rpcSupply: string | null | undefined): string | null {
  if (typeof rpcSupply !== 'string') return null
  const raw = rpcSupply.trim()
  if (!raw || raw === '0x' || raw === '0x0') return null
  try {
    const v = raw.startsWith('0x') ? BigInt(raw) : (/^\d+$/.test(raw) ? BigInt(raw) : null)
    return v != null && v > BigInt(0) ? v.toString() : null
  } catch {
    return null
  }
}

// HOLDER PERCENT DENOMINATOR — DISCLOSED (cross-chain holder integrity audit).
// Percentages must divide by the token's REAL total supply. A returned holder page (GoldRush caps
// at 100 rows, the resolver at 200) is a bounded sample; summing it as the denominator inflates
// every holder's share (a pool holding 10% of supply becomes much more when the page covers only
// part of supply) and fed public Top-N, Stage 1/2 and risk. The summed-sample denominator is
// therefore never selected: without a real supply, percentages stay unavailable with a reason.
export type HolderPercentDenominatorSource = 'rpc_onchain' | 'rpc_phase1' | 'provider_total_supply'

export const HOLDER_PERCENT_NO_TOTAL_SUPPLY_REASON = 'holder_percentages_unavailable_no_total_supply'

const toPositiveBigInt = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v > BigInt(0) ? v : null
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  if (!s || s === '0x' || s === '0x0') return null
  if (!/^0x[0-9a-fA-F]+$/.test(s) && !/^\d+$/.test(s)) return null
  try {
    const b = BigInt(s)
    return b > BigInt(0) ? b : null
  } catch {
    return null
  }
}

/** Real-supply denominator for holder percentages, strongest first. Never a sum of sample rows. */
export function selectHolderPercentDenominator(input: {
  rpcOnchainTotalSupply?: bigint | string | null
  rpcPhase1TotalSupplyHex?: string | null
  providerTotalSupplyRaw?: string | number | null
}): { totalSupply: bigint; source: HolderPercentDenominatorSource } | null {
  const onchain = toPositiveBigInt(input.rpcOnchainTotalSupply ?? null)
  if (onchain != null) return { totalSupply: onchain, source: 'rpc_onchain' }
  const phase1 = toPositiveBigInt(input.rpcPhase1TotalSupplyHex ?? null)
  if (phase1 != null) return { totalSupply: phase1, source: 'rpc_phase1' }
  const provider = toPositiveBigInt(input.providerTotalSupplyRaw ?? null)
  if (provider != null) return { totalSupply: provider, source: 'provider_total_supply' }
  return null
}
