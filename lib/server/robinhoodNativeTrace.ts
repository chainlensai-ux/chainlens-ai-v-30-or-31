// Robinhood native-trace adapter: the target tx's internal native transfers from Blockscout (existing
// transport: community host, then the PRO gateway on 401/403). Injected into PnL V1's forensics by the sidecar
// scan (robinhoodWalletScanner.ts) so the V1 lane itself never depends on the Blockscout transport.

import { getBlockscoutTransactionInternalTransactions } from './robinhoodBlockscoutEvidence'
import type { RhNativeTransfer } from './robinhoodMixedRouteForensics'
import type { FetchLike, RobinhoodPnlV1Deps } from './robinhoodPnlV1'

const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '')

/** The target tx's internal native transfers from Blockscout (existing transport); null on any doubt. */
export function blockscoutNativeTransfersForTx(fetchImpl: FetchLike): NonNullable<RobinhoodPnlV1Deps['nativeTransfersForTx']> {
  return async (txHash) => {
    const { data } = await getBlockscoutTransactionInternalTransactions(txHash, fetchImpl)
    // A paginated (incomplete) trace is not proof of the full native flow.
    if (!data || !Array.isArray(data.items) || data.next_page_params) return null
    const out: RhNativeTransfer[] = []
    for (const it of data.items) {
      const from = lower(it.from?.hash)
      const to = lower(it.to?.hash)
      let value: bigint
      try { value = BigInt(it.value ?? '0') } catch { return null }
      if (!from || !to) continue
      // FAIL CLOSED: Blockscout v2 internal transactions carry `success: boolean` (with `error` set when it
      // failed). An entry without an explicit boolean has an unknown execution status, which is not proof —
      // the whole trace is treated as unavailable rather than guessing the transfer happened.
      if (typeof it.success !== 'boolean') return null
      out.push({ from, to, value, success: it.success })
    }
    return out
  }
}

