// V2 SCANNER PREVIEW component — receives ONLY chainSelection from the new engine's report.
import type { ChainSelectionResult } from '@/src/modules/chainSelection/types'

export function ChainSelectionView({ data }: { data: ChainSelectionResult }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Chain Selection</h3>
      <p>
        {data.activeChainCount} active / {data.dustChainCount} dust
      </p>
      <ul>
        {data.chains.map((chain) => (
          <li key={chain.chain}>
            <strong>{chain.chain}</strong> — {chain.status} (value ${chain.visible_value_usd.toFixed(2)}, txs {chain.wallet_side_transactions}, swaps {chain.swapCandidateEvents})
          </li>
        ))}
      </ul>
    </section>
  )
}

export default ChainSelectionView
