// V2 SCANNER PREVIEW component — receives ONLY the new portfolioAssembler token list.
//
// V2-SAFE GUARD: `data` defensively falls back to [] rather than crashing if the value is missing
// or malformed at runtime.
import type { TokenListEntry } from '@/src/modules/portfolio/types'

export function TokenListView({ data }: { data: TokenListEntry[] | null | undefined }) {
  const entries = Array.isArray(data) ? data : []

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Tokens ({entries.length})</h3>
      {entries.length === 0 ? (
        <p>No holdings found.</p>
      ) : (
        <ul>
          {entries.map((token) => (
            <li key={`${token.chain}-${token.contract}`}>
              {token.symbol} on {token.chain} — {token.amount.toLocaleString()} — {token.valueUsd != null ? `$${token.valueUsd.toFixed(2)}` : 'price unavailable'}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default TokenListView
