// V2 SCANNER PREVIEW component — top-level holdings section, composing PortfolioValueView +
// ChainValueBreakdownView + TokenListView. Receives ONLY the new holdingsEngine/portfolioAssembler
// output (never anything from the old profiler's holdings shape).
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import { ChainValueBreakdownView } from './ChainValueBreakdownView'
import { PortfolioValueView } from './PortfolioValueView'
import { TokenListView } from './TokenListView'

export function HoldingsView({ holdings, portfolio }: { holdings: TokenHolding[]; portfolio: PortfolioSummary }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h2>Holdings</h2>
      <PortfolioValueView data={portfolio} />
      <ChainValueBreakdownView data={portfolio.chainValueBreakdown} />
      <TokenListView data={portfolio.tokens} />
      <p style={{ fontSize: 12, opacity: 0.6 }}>{holdings.length} raw token balance(s) fetched across scanned chains.</p>
    </section>
  )
}

export default HoldingsView
