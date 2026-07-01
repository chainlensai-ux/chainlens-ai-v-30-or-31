// V2 SCANNER PREVIEW component — receives ONLY the new portfolioAssembler summary.
import type { PortfolioSummary } from '@/src/modules/portfolio/types'

export function PortfolioValueView({ data }: { data: PortfolioSummary }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Portfolio Value</h3>
      <p>{data.totalValueUsd != null ? `$${data.totalValueUsd.toFixed(2)}` : 'Not available — no priced holdings found'}</p>
    </section>
  )
}

export default PortfolioValueView
