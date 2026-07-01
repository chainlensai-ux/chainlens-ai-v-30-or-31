// V2 SCANNER PREVIEW component — receives ONLY timelines.sellTimeline from the new engine's report.
import type { SellTimeline } from '@/src/modules/timelineBuilder/types'

export function SellTimelineView({ data }: { data: SellTimeline }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Sell Timeline ({data.totalSells})</h3>
      {data.entries.length === 0 ? (
        <p>No sells found on active chains.</p>
      ) : (
        <ul>
          {data.entries.map((entry, i) => (
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
