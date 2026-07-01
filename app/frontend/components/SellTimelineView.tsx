// V2 SCANNER PREVIEW component — receives ONLY timelines.sellTimeline from the new engine's report.
//
// V2-SAFE GUARD: `data`/`data.entries` defensively falls back to [] rather than crashing if the
// value is missing or malformed at runtime.
import type { SellTimeline } from '@/src/modules/timelineBuilder/types'

export function SellTimelineView({ data }: { data: SellTimeline | null | undefined }) {
  const entries = Array.isArray(data?.entries) ? data!.entries : []
  const totalSells = typeof data?.totalSells === 'number' ? data.totalSells : entries.length

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Sell Timeline ({totalSells})</h3>
      {entries.length === 0 ? (
        <p>No sells found on active chains.</p>
      ) : (
        <ul>
          {entries.map((entry, i) => (
            <li key={`${entry.txHash}-${i}`}>
              {new Date(entry.timestamp).toISOString().slice(0, 10)} — {entry.symbol} on {entry.chain} — amount {entry.amount} — confidence: {entry.confidence}
              {entry.proceedsUsdEstimate != null ? ` ($${entry.proceedsUsdEstimate.toFixed(2)} proceeds)` : ' (no priced estimate)'}
              {entry.matchedBuyLotId ? ` — matched to ${entry.matchedBuyLotId}` : ' — unmatched'}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default SellTimelineView
