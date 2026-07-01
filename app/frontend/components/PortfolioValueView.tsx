// V2 SCANNER PREVIEW component — receives ONLY the new portfolioAssembler summary.
//
// V2-SAFE GUARD: `data` itself defensively falls back to a safe default rather than crashing if
// the value is missing at runtime.
import type { PortfolioSummary } from '@/src/modules/portfolio/types'

export function PortfolioValueView({ data }: { data: PortfolioSummary | null | undefined }) {
  const totalValueUsd = data?.totalValueUsd ?? null

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Portfolio Value</h3>
      <p>{totalValueUsd != null ? `$${totalValueUsd.toFixed(2)}` : 'Not available — no priced holdings found'}</p>
    </section>
  )
}

export default PortfolioValueView
