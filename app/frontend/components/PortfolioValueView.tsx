// V2 SCANNER PREVIEW component — receives ONLY the new portfolioAssembler summary.
//
// V2-SAFE GUARD: `data` itself defensively falls back to a safe default rather than crashing if
// the value is missing at runtime.
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import { portfolioCoverageCopy } from '@/app/frontend/lib/mergedWalletView'

export function PortfolioValueView({
  data,
  robinhoodIncluded = false,
}: {
  data: PortfolioSummary | null | undefined
  // ONE CANONICAL RESULT, UPDATED DISCLOSURE (split-Wallet-Scanner-results fix task): optional —
  // pass true when this same scan's Robinhood Chain result was actually, successfully scanned and
  // already summed into `data`'s total by the caller, so the coverage line below stops falsely
  // claiming Robinhood is excluded. Defaults to false (this component's prior behavior) since this
  // preview receives only the V1 `PortfolioSummary`, which never itself includes Robinhood.
  robinhoodIncluded?: boolean
}) {
  const totalValueUsd = data?.totalValueUsd ?? null

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Supported On-Chain Portfolio Value</h3>
      <p>{totalValueUsd != null ? `$${totalValueUsd.toFixed(2)}` : 'Not available — no priced holdings found'}</p>
      {/* COVERAGE DISCLOSURE, UPDATED DISCLOSURE (split-Wallet-Scanner-results fix task): Robinhood
          Chain scanning now genuinely exists in this codebase — the old comment/copy here claiming
          "this codebase has no custodial/exchange integration" is false. Conditional on the real,
          per-scan `robinhoodIncluded` flag rather than a fixed, unconditional claim. */}
      <p style={{ fontSize: '11px', color: '#888' }}>
        {portfolioCoverageCopy(robinhoodIncluded)}
      </p>
    </section>
  )
}

export default PortfolioValueView
