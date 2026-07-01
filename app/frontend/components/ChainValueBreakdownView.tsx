// V2 SCANNER PREVIEW component — receives ONLY the new portfolioAssembler chain value breakdown.
import type { ChainValueBreakdownEntry } from '@/src/modules/portfolioAssembler/types'

export function ChainValueBreakdownView({ data }: { data: ChainValueBreakdownEntry[] }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Chain Value Breakdown</h3>
      {data.length === 0 ? (
        <p>No priced value on any chain.</p>
      ) : (
        <ul>
          {data.map((entry) => (
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
