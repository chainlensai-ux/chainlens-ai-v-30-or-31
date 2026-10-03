// lib/walletScan/portfolioEvidence.ts — what the Wallet Scanner actually KNOWS about a portfolio's value.
//
// `$0.00` means a verified zero: the holdings providers answered completely and found nothing to value.
// It never means "unknown". A plain `number | null` total could not tell those apart, so a lane whose
// holdings provider failed (EVM: buildPortfolio([]) -> totalValueUsd 0) or whose holdings could not be
// priced (Robinhood: portfolioTotalUsd null) was summed as 0 and rendered `$0.00`. This module is the
// one explicit shape for that knowledge, used by the worker's canonical total, the scan orchestrator,
// and every UI surface (hero, Portfolio Intelligence, CORTEX, watchlist) via mergedWalletView.ts.
//
// Pure, no I/O. Never fabricates a value for an unpriced holding.

export type PortfolioValueStatus = 'verified' | 'partial' | 'unavailable' | 'verified_zero'

export type PortfolioEvidence = {
  /** The full portfolio value — only when every holding is priced (verified) or there are none (verified_zero). */
  valueUsd: number | null
  /** The sum of the holdings that ARE priced (a known lower bound); null when nothing is priced. */
  pricedSubtotalUsd: number | null
  status: PortfolioValueStatus
  pricedHoldings: number
  /** Holdings with no evidence-backed price (never counted as $0). */
  unpricedHoldings: number
  /** The holdings providers answered for every requested chain (needed to prove "nothing held"). */
  holdingsComplete: boolean
  /** Short machine reason when not verified (e.g. 'holdings_provider_unavailable', 'no_holdings_priced'). */
  reason: string | null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * One lane's evidence from its holdings: `values` has one entry per held asset — its USD value, or null
 * when it could not be priced. `materialUnpriced` (optional) says how many of the null entries could be
 * material; when given, only those make the lane partial (immaterial dust/spam stays excluded, as the
 * Portfolio card already discloses). A lane with NO priced holding is never a verified number.
 */
export function evidenceFromHoldings(input: {
  holdingsComplete: boolean
  values: ReadonlyArray<number | null>
  materialUnpriced?: number | null
  reason?: string | null
}): PortfolioEvidence {
  const priced = input.values.filter(finite)
  const unpriced = input.values.length - priced.length
  const subtotal = priced.reduce((s, v) => s + v, 0)
  const base = { pricedHoldings: priced.length, unpricedHoldings: unpriced, holdingsComplete: input.holdingsComplete }
  if (input.values.length === 0) {
    return input.holdingsComplete
      ? { ...base, valueUsd: 0, pricedSubtotalUsd: 0, status: 'verified_zero', reason: null }
      : { ...base, valueUsd: null, pricedSubtotalUsd: null, status: 'unavailable', reason: input.reason ?? 'holdings_provider_unavailable' }
  }
  if (priced.length === 0) return { ...base, valueUsd: null, pricedSubtotalUsd: null, status: 'unavailable', reason: input.reason ?? 'no_holdings_priced' }
  const blockingUnpriced = input.materialUnpriced != null ? Math.min(unpriced, Math.max(0, input.materialUnpriced)) : unpriced
  if (blockingUnpriced === 0 && input.holdingsComplete) return { ...base, valueUsd: subtotal, pricedSubtotalUsd: subtotal, status: 'verified', reason: null }
  return {
    ...base, valueUsd: null, pricedSubtotalUsd: subtotal, status: 'partial',
    reason: input.reason ?? (blockingUnpriced > 0 ? 'some_holdings_unpriced' : 'holdings_provider_incomplete'),
  }
}

/**
 * The canonical merge of independent lanes (EVM, Robinhood):
 *   - every lane verified_zero                          -> verified_zero ($0.00)
 *   - every lane verified / verified_zero               -> verified (their sum)
 *   - otherwise, at least one lane has priced holdings  -> partial (the known priced subtotal)
 *   - otherwise (nothing priced anywhere, something unknown) -> unavailable — never zero.
 * A verified_zero lane never turns another lane's unknown into a known $0.
 */
export function mergePortfolioEvidence(lanes: ReadonlyArray<PortfolioEvidence | null | undefined>): PortfolioEvidence {
  const ls = lanes.filter((l): l is PortfolioEvidence => l != null)
  const sumOf = (pick: (l: PortfolioEvidence) => number | null) => ls.reduce((s, l) => s + (pick(l) ?? 0), 0)
  const pricedHoldings = ls.reduce((s, l) => s + l.pricedHoldings, 0)
  const unpricedHoldings = ls.reduce((s, l) => s + l.unpricedHoldings, 0)
  const holdingsComplete = ls.length > 0 && ls.every((l) => l.holdingsComplete)
  const base = { pricedHoldings, unpricedHoldings, holdingsComplete }
  if (ls.length === 0) return { ...base, valueUsd: null, pricedSubtotalUsd: null, status: 'unavailable', reason: 'no_portfolio_evidence' }
  if (ls.every((l) => l.status === 'verified_zero')) return { ...base, valueUsd: 0, pricedSubtotalUsd: 0, status: 'verified_zero', reason: null }
  if (ls.every((l) => l.status === 'verified' || l.status === 'verified_zero')) {
    const v = sumOf((l) => l.valueUsd)
    return { ...base, valueUsd: v, pricedSubtotalUsd: v, status: 'verified', reason: null }
  }
  const known = ls.filter((l) => (l.status === 'verified' || l.status === 'partial') && l.pricedSubtotalUsd != null && l.pricedHoldings > 0)
  if (known.length > 0) {
    const firstGap = ls.find((l) => l.status === 'partial' || l.status === 'unavailable')
    return { ...base, valueUsd: null, pricedSubtotalUsd: known.reduce((s, l) => s + (l.pricedSubtotalUsd ?? 0), 0), status: 'partial', reason: firstGap?.reason ?? 'some_holdings_unpriced' }
  }
  return { ...base, valueUsd: null, pricedSubtotalUsd: null, status: 'unavailable', reason: ls.find((l) => l.status === 'unavailable')?.reason ?? 'no_holdings_priced' }
}

/**
 * The single number a surface may show (and the backward-compatible `totalValueUsd`): the full value when
 * verified / verified_zero, the known priced subtotal when partial (shown WITH a "Partial" marker), and
 * null when unavailable (shown as "Value unavailable", never $0.00).
 */
export function portfolioDisplayValueUsd(e: PortfolioEvidence | null | undefined): number | null {
  if (!e) return null
  if (e.status === 'verified' || e.status === 'verified_zero') return e.valueUsd
  if (e.status === 'partial') return e.pricedSubtotalUsd
  return null
}

export const PORTFOLIO_VALUE_UNAVAILABLE_TEXT = 'Value unavailable'
export const PORTFOLIO_VALUE_PARTIAL_LABEL = 'Partial'

/** Display text for a value: `fmt(value)`, `fmt(subtotal) · Partial`, or "Value unavailable". */
export function portfolioValueText(e: PortfolioEvidence | null | undefined, fmt: (usd: number) => string): string {
  const v = portfolioDisplayValueUsd(e)
  if (v == null) return PORTFOLIO_VALUE_UNAVAILABLE_TEXT
  return e?.status === 'partial' ? `${fmt(v)} · ${PORTFOLIO_VALUE_PARTIAL_LABEL}` : fmt(v)
}

/** Pricing coverage by holding count (truthful: priced / all held assets in the evidence). */
export function portfolioCoverage(e: PortfolioEvidence | null | undefined): { priced: number; total: number; pct: number } | null {
  if (!e) return null
  const total = e.pricedHoldings + e.unpricedHoldings
  if (total <= 0) return null
  return { priced: e.pricedHoldings, total, pct: Math.round((e.pricedHoldings / total) * 100) }
}

/** The second line under a Partial value, e.g. "43/50 holdings priced"; null when not partial. */
export function portfolioCoverageText(e: PortfolioEvidence | null | undefined): string | null {
  if (!e || e.status !== 'partial') return null
  const c = portfolioCoverage(e)
  return c ? `${c.priced}/${c.total} holdings priced` : null
}
