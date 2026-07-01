// V2 SCANNER PREVIEW component — receives ONLY timelines.distributionTimeline from the new
// engine's report.
//
// V2-SAFE GUARD: `data`/`data.entries` defensively falls back to [] rather than crashing if the
// value is missing or malformed at runtime.
import type { DistributionTimeline } from '@/src/modules/timelineBuilder/types'

export function DistributionTimelineView({ data }: { data: DistributionTimeline | null | undefined }) {
  const entries = Array.isArray(data?.entries) ? data!.entries : []
  const totalDistributions = typeof data?.totalDistributions === 'number' ? data.totalDistributions : entries.length

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Distribution Timeline ({totalDistributions})</h3>
      {entries.length === 0 ? (
        <p>No non-sale outbound transfers found on active chains.</p>
      ) : (
        <ul>
          {entries.map((entry, i) => (
            <li key={`${entry.txHash}-${i}`}>
              {new Date(entry.timestamp).toISOString().slice(0, 10)} — {entry.symbol} on {entry.chain} — amount {entry.amount} — to {entry.recipientType} ({entry.recipientAddress.slice(0, 6)}...{entry.recipientAddress.slice(-4)})
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default DistributionTimelineView
