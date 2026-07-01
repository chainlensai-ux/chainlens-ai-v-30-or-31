// V2 SCANNER PREVIEW component — receives ONLY timelines.buyTimeline from the new engine's report.
import type { BuyTimeline } from '@/src/modules/timelineBuilder/types'

export function BuyTimelineView({ data }: { data: BuyTimeline }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Buy Timeline ({data.totalBuys})</h3>
      {data.entries.length === 0 ? (
        <p>No buys found on active chains.</p>
      ) : (
        <ul>
          {data.entries.map((entry, i) => (
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
