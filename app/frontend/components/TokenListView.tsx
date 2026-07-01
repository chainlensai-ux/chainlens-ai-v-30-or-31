// V2 SCANNER PREVIEW component — receives ONLY the new portfolioAssembler token list.
import type { TokenListEntry } from '@/src/modules/portfolioAssembler/types'

export function TokenListView({ data }: { data: TokenListEntry[] }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Tokens ({data.length})</h3>
      {data.length === 0 ? (
        <p>No holdings found.</p>
      ) : (
        <ul>
          {data.map((token) => (
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
