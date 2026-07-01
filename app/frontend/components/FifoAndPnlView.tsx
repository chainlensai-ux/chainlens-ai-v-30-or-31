// V2 SCANNER PREVIEW component — receives ONLY fifoAndPnl from the new engine's report. Renders
// exactly the fields the new fifoEngine module produces (matchedLots, unmatchedBuys/Sells,
// realizedPnlUsd, unrealizedPnlUsd, costBasisUsd, publicPnlStatus, integrityFlags) — there is no
// win rate, profit skill, or wallet score field in this engine to render.
//
// V2-SAFE GUARD: every field defensively falls back to a safe default rather than crashing if
// `data` (or `data.matchedLots`/`data.integrityFlags`) is missing or malformed at runtime.
import type { FifoOutput } from '@/src/modules/fifoEngine/types'

function fmtUsd(value: number | null | undefined): string {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

export function FifoAndPnlView({ data }: { data: FifoOutput | null | undefined }) {
  const matchedLots = Array.isArray(data?.matchedLots) ? data!.matchedLots : []
  const publicPnlStatus = data?.publicPnlStatus ?? 'unavailable'
  const unmatchedBuys = data?.unmatchedBuys ?? 0
  const unmatchedSells = data?.unmatchedSells ?? 0
  const hardInvalid = data?.integrityFlags?.hardInvalid ?? true
  const estimateOnlyLotsExcluded = data?.integrityFlags?.estimateOnlyLotsExcluded ?? 0
  const syntheticLotsExcluded = data?.integrityFlags?.syntheticLotsExcluded ?? 0

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>FIFO &amp; PnL</h3>
      <p>Status: {publicPnlStatus}</p>
      <p>Realized PnL: {fmtUsd(data?.realizedPnlUsd)}</p>
      <p>Unrealized PnL: {fmtUsd(data?.unrealizedPnlUsd)}</p>
      <p>Cost basis: {fmtUsd(data?.costBasisUsd)}</p>
      <p>
        Matched lots: {matchedLots.length} · Unmatched buys: {unmatchedBuys} · Unmatched sells: {unmatchedSells}
      </p>
      <p>
        Integrity: hardInvalid={String(hardInvalid)}, estimateOnlyLotsExcluded={estimateOnlyLotsExcluded}, syntheticLotsExcluded={syntheticLotsExcluded}
      </p>
    </section>
  )
}

export default FifoAndPnlView
