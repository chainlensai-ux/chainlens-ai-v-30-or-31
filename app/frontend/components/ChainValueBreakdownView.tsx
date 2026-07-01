// V2 SCANNER PREVIEW component — receives ONLY the new portfolioAssembler chain value breakdown.
//
// V2-SAFE GUARD: `data` defensively falls back to [] rather than crashing if the value is missing
// or malformed at runtime.
import type { ChainValueBreakdownEntry } from '@/src/modules/portfolio/types'

export function ChainValueBreakdownView({ data }: { data: ChainValueBreakdownEntry[] | null | undefined }) {
  const entries = Array.isArray(data) ? data : []

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Chain Value Breakdown</h3>
      {entries.length === 0 ? (
        <p>No priced value on any chain.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.chain}>
              {entry.chain}: ${entry.valueUsd.toFixed(2)} ({entry.percent.toFixed(1)}%)
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default ChainValueBreakdownView
