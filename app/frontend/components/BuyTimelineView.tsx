// V2 SCANNER PREVIEW component — receives ONLY timelines.buyTimeline from the new engine's report.
//
// V2-SAFE GUARD: `data` (or `data.entries`) is defensively treated as possibly missing/malformed
// at runtime — a TypeScript type is a compile-time contract only, not a runtime guarantee across
// a network/JSON boundary. Every array read here falls back to [] rather than crashing.
import type { BuyTimeline } from '@/src/modules/timelineBuilder/types'

export function BuyTimelineView({ data }: { data: BuyTimeline | null | undefined }) {
  const entries = Array.isArray(data?.entries) ? data!.entries : []
  const totalBuys = typeof data?.totalBuys === 'number' ? data.totalBuys : entries.length

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Buy Timeline ({totalBuys})</h3>
      {entries.length === 0 ? (
        <p>No buys found on active chains.</p>
      ) : (
        <ul>
          {entries.map((entry, i) => (
            <li key={`${entry.txHash}-${i}`}>
              {new Date(entry.timestamp).toISOString().slice(0, 10)} — {entry.symbol} on {entry.chain} ({entry.sourceType}) — amount {entry.amount}
              {entry.usdValueEstimate != null ? ` ($${entry.usdValueEstimate.toFixed(2)})` : ' (no priced estimate)'}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default BuyTimelineView
