// V2 SCANNER PREVIEW component — receives ONLY fifoAndPnl from the new engine's report. Renders
// exactly the fields the new fifoEngine module produces (matchedLots, unmatchedBuys/Sells,
// realizedPnlUsd, unrealizedPnlUsd, costBasisUsd, publicPnlStatus, integrityFlags) — there is no
// win rate, profit skill, or wallet score field in this engine to render.
import type { FifoOutput } from '@/src/modules/fifoEngine/types'

function fmtUsd(value: number | null): string {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

export function FifoAndPnlView({ data }: { data: FifoOutput }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>FIFO &amp; PnL</h3>
      <p>Status: {data.publicPnlStatus}</p>
      <p>Realized PnL: {fmtUsd(data.realizedPnlUsd)}</p>
      <p>Unrealized PnL: {fmtUsd(data.unrealizedPnlUsd)}</p>
      <p>Cost basis: {fmtUsd(data.costBasisUsd)}</p>
      <p>
        Matched lots: {data.matchedLots.length} · Unmatched buys: {data.unmatchedBuys} · Unmatched sells: {data.unmatchedSells}
      </p>
      <p>
        Integrity: hardInvalid={String(data.integrityFlags.hardInvalid)}, estimateOnlyLotsExcluded={data.integrityFlags.estimateOnlyLotsExcluded}, syntheticLotsExcluded={data.integrityFlags.syntheticLotsExcluded}
      </p>
    </section>
  )
}

export default FifoAndPnlView
