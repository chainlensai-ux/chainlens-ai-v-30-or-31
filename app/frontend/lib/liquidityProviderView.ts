// What the Wallet Scanner's Liquidity Provider card shows, from the scan's liquidityActivity and
// lpPositions (src/lib/liquidityLegGuard.ts, src/lib/walletLpPositions.ts). Pure; null hides the card.
import type { LiquidityActivitySummary } from '@/src/lib/liquidityLegGuard'
import type { WalletLpPositionsSummary } from '@/src/lib/walletLpPositions'
import type { LpFeeIncomeSummary } from '@/src/lib/lpFeeIncome'

export type LiquidityProviderView = {
  lpStrategyWallet: boolean
  liquiditySharePct: number | null
  deposits: number
  withdrawals: number
  openPositions: number
  pricedPositions: number
  positionsValueUsd: number | null
  /** Wallet tokens plus open liquidity positions; null when either part is unknown. */
  totalWithPositionsUsd: number | null
  positionsNote: string | null
  /** Realized LP fee income: proven fee payouts sold with proven proceeds. Null when none is proven. */
  feeIncome: LpFeeIncomeView | null
}

export type LpFeeIncomeView = {
  realizedUsd: number
  realizedNative: number | null
  salesProven: number
  salesUnproven: number
  payoutsProven: number
  tokenSymbols: string[]
  note: string
}

export function buildLpFeeIncomeView(summary: LpFeeIncomeSummary | null | undefined): LpFeeIncomeView | null {
  if (summary?.status !== 'proven' || summary.realizedFeeIncomeUsd == null || !Number.isFinite(summary.realizedFeeIncomeUsd)) return null
  const sold = summary.tokens.filter((t) => t.salesProven > 0)
  const salesProven = sold.reduce((n, t) => n + t.salesProven, 0)
  const salesUnproven = summary.tokens.reduce((n, t) => n + t.salesUnproven, 0)
  const symbols = sold.map((t) => t.symbol ?? `${t.token.slice(0, 6)}…`)
  const note = `From ${salesProven} sale${salesProven === 1 ? '' : 's'} of ${symbols.join(', ')} this wallet received only as LP fees `
    + `(${summary.payoutTxsProven} fee payout${summary.payoutTxsProven === 1 ? '' : 's'} proven on-chain), counted at $0 cost and kept separate from trading PnL.`
    + (salesUnproven > 0 ? ` ${salesUnproven} other sale${salesUnproven === 1 ? '' : 's'} could not be proven and ${salesUnproven === 1 ? 'is' : 'are'} not included.` : '')
  return { realizedUsd: summary.realizedFeeIncomeUsd, realizedNative: summary.realizedFeeIncomeNative, salesProven, salesUnproven, payoutsProven: summary.payoutTxsProven, tokenSymbols: symbols, note }
}

export function buildLiquidityProviderView(
  activity: LiquidityActivitySummary | null | undefined,
  positions: WalletLpPositionsSummary | null | undefined,
  walletTotalUsd: number | null | undefined,
  feeIncomeSummary?: LpFeeIncomeSummary | null,
): LiquidityProviderView | null {
  const openPositions = positions?.openPositions ?? 0
  const feeIncome = buildLpFeeIncomeView(feeIncomeSummary)
  if (!activity?.lpStrategyWallet && openPositions === 0 && !feeIncome) return null
  const pricedPositions = positions?.pricedPositions ?? 0
  const positionsValueUsd = pricedPositions > 0 ? positions!.totalValueUsd : null
  const positionsNote = !positions || positions.status === 'not_attempted' || positions.status === 'unavailable'
    || (openPositions === 0 && (positions.positionReadErrors ?? 0) > 0)
    ? 'Open positions could not be read on this scan.'
    : openPositions === 0 && positions.reason === 'position_reads_stopped_by_budget'
      ? `Checked the newest ${positions.positionsChecked} of ${positions.mintsFound} positions this wallet minted; none are still open. Older ones were not checked on this scan.`
    : openPositions === 0
      ? 'No open positions found from the liquidity transactions in this scan window.'
      : pricedPositions < openPositions
        ? `${openPositions - pricedPositions} of ${openPositions} positions hold a token with no current price and are not valued.`
        : null
  return {
    lpStrategyWallet: activity?.lpStrategyWallet ?? false,
    liquiditySharePct: activity ? Math.round(activity.liquidityTxShare * 100) : null,
    deposits: activity?.liquidityAddTxs ?? 0,
    withdrawals: activity?.liquidityRemoveTxs ?? 0,
    openPositions,
    pricedPositions,
    positionsValueUsd,
    totalWithPositionsUsd: positionsValueUsd != null && typeof walletTotalUsd === 'number' && Number.isFinite(walletTotalUsd)
      ? walletTotalUsd + positionsValueUsd
      : null,
    positionsNote,
    feeIncome,
  }
}

// LP cadence: deposits + withdrawals per day over the span the scan read. "Automated" is only claimed
// when the cadence is beyond what a person does by hand; below that the wallet is a liquidity provider
// with no automation claim either way.
export const LP_AUTOMATED_TXS_PER_DAY = 20

export type LpCadence = {
  lpTxs: number
  txsPerDay: number | null
  automated: boolean
}

export function selectLpCadence(
  activity: Pick<LiquidityActivitySummary, 'lpStrategyWallet' | 'liquidityAddTxs' | 'liquidityRemoveTxs'> | null | undefined,
  spanDays: number | null | undefined,
): LpCadence | null {
  if (!activity?.lpStrategyWallet) return null
  const lpTxs = (activity.liquidityAddTxs ?? 0) + (activity.liquidityRemoveTxs ?? 0)
  const txsPerDay = lpTxs > 0 && typeof spanDays === 'number' && Number.isFinite(spanDays) && spanDays > 0
    ? lpTxs / Math.max(1, spanDays)
    : null
  return { lpTxs, txsPerDay, automated: txsPerDay != null && txsPerDay >= LP_AUTOMATED_TXS_PER_DAY }
}

/** "~573 LP tx/day" — whole numbers above 10, one decimal below. */
export function fmtLpCadence(txsPerDay: number): string {
  return `~${txsPerDay >= 10 ? Math.round(txsPerDay).toLocaleString() : txsPerDay.toFixed(1)} LP tx/day`
}
