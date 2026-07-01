// V2 SCANNER PREVIEW component — top-level holdings section, composing PortfolioValueView +
// ChainValueBreakdownView + TokenListView. Receives ONLY the new holdingsEngine/portfolioAssembler
// output (never anything from the old profiler's holdings shape).
//
// V2-SAFE GUARD: `holdings` and `portfolio` (and its nested fields) defensively fall back to safe
// empty defaults rather than crashing if either is missing or malformed at runtime.
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import { ChainValueBreakdownView } from './ChainValueBreakdownView'
import { PortfolioValueView } from './PortfolioValueView'
import { TokenListView } from './TokenListView'

export function HoldingsView({
  holdings,
  portfolio,
}: {
  holdings: TokenHolding[] | null | undefined
  portfolio: PortfolioSummary | null | undefined
}) {
  const safeHoldings = Array.isArray(holdings) ? holdings : []
  const chainValueBreakdown = Array.isArray(portfolio?.chainValueBreakdown) ? portfolio!.chainValueBreakdown : []
  const tokens = Array.isArray(portfolio?.tokens) ? portfolio!.tokens : []

  return (
    <section style={{ marginBottom: 20 }}>
      <h2>Holdings</h2>
      <PortfolioValueView data={portfolio} />
      <ChainValueBreakdownView data={chainValueBreakdown} />
      <TokenListView data={tokens} />
      <p style={{ fontSize: 12, opacity: 0.6 }}>{safeHoldings.length} raw token balance(s) fetched across scanned chains.</p>
    </section>
  )
}

export default HoldingsView
