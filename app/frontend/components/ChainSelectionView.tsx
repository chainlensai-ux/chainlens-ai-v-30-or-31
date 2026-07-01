// V2 SCANNER PREVIEW component — receives ONLY chainSelection from the new engine's report.
//
// V2-SAFE GUARD: `data.chains` defensively falls back to [] rather than crashing if the value is
// missing or malformed at runtime.
import type { ChainSelectionResult } from '@/src/modules/chainSelection/types'

export function ChainSelectionView({ data }: { data: ChainSelectionResult | null | undefined }) {
  const chains = Array.isArray(data?.chains) ? data!.chains : []
  const activeChainCount = typeof data?.activeChainCount === 'number' ? data.activeChainCount : 0
  const dustChainCount = typeof data?.dustChainCount === 'number' ? data.dustChainCount : 0

  return (
    <section style={{ marginBottom: 20 }}>
      <h3>Chain Selection</h3>
      <p>
        {activeChainCount} active / {dustChainCount} dust
      </p>
      <ul>
        {chains.map((chain) => (
          <li key={chain.chain}>
            <strong>{chain.chain}</strong> — {chain.status} (value ${chain.visible_value_usd.toFixed(2)}, txs {chain.wallet_side_transactions}, swaps {chain.swapCandidateEvents})
          </li>
        ))}
      </ul>
    </section>
  )
}

export default ChainSelectionView
