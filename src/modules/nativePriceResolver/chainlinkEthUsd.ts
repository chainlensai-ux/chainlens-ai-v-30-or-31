// Chainlink ETH/USD read on-chain from Base at an exact past block — the historical ETH price source no
// market-data provider can rate-limit. It goes through this project's own Base RPC (a separate quota
// from GoldRush, GeckoTerminal and CoinGecko), costs one eth_call per UTC day, and answers for any day
// since the feed existed. Base produces a block every 2 seconds from genesis, so the block for a
// timestamp is computed exactly (checked live: the computed block's own timestamp equals the target).
//
// Live failure this closes: on a cold scan GeckoTerminal and CoinGecko both answered 429 and GoldRush
// returned no ETH price, so 13 of 13 ETH/USD days were unresolved and every native-quoted sale failed
// closed (LP fee income $0 instead of $6,234).

export const CHAINLINK_ETH_USD_BASE_FEED = '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70'
export const BASE_GENESIS_TIMESTAMP_SEC = 1686789347
export const BASE_BLOCK_TIME_SEC = 2
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c'
const FEED_DECIMALS = 8

export type OnchainNativeUsdReading = { priceUsd: number; updatedAtSec: number } | { error: string }
export type OnchainNativeUsdReader = (atTimestampSec: number, signal?: AbortSignal) => Promise<OnchainNativeUsdReading>

export function baseBlockAtTimestamp(timestampSec: number): number | null {
  if (!Number.isFinite(timestampSec) || timestampSec < BASE_GENESIS_TIMESTAMP_SEC) return null
  return Math.floor((timestampSec - BASE_GENESIS_TIMESTAMP_SEC) / BASE_BLOCK_TIME_SEC)
}

// PURE. latestRoundData() returns (roundId, answer, startedAt, updatedAt, answeredInRound), 32 bytes each.
export function decodeLatestRoundData(hex: unknown): OnchainNativeUsdReading {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{320}$/.test(hex)) return { error: 'chainlink_malformed_response' }
  const word = (i: number) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`)
  const answer = word(1)
  // int256: a set top bit is a negative answer, never a real ETH price.
  if (answer >> BigInt(255) === BigInt(1) || answer === BigInt(0)) return { error: 'chainlink_non_positive_answer' }
  return { priceUsd: Number(answer) / 10 ** FEED_DECIMALS, updatedAtSec: Number(word(3)) }
}

export function createChainlinkBaseEthUsdReader(deps: {
  rpcUrl: string | null
  /** Called before every RPC call; false = budget exhausted, the call is not made. */
  consume: () => boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): OnchainNativeUsdReader | null {
  if (!deps.rpcUrl) return null
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (atTimestampSec, signal) => {
    const block = baseBlockAtTimestamp(atTimestampSec)
    if (block === null) return { error: 'chainlink_before_base_genesis' }
    if (!deps.consume()) return { error: 'chainlink_rpc_budget_exhausted' }
    try {
      const timeout = AbortSignal.timeout(deps.timeoutMs ?? 5_000)
      const res = await fetchImpl(deps.rpcUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: CHAINLINK_ETH_USD_BASE_FEED, data: LATEST_ROUND_DATA_SELECTOR }, `0x${block.toString(16)}`] }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!res.ok) return { error: `chainlink_http_${res.status}` }
      const json = await res.json().catch(() => null) as { result?: unknown; error?: unknown } | null
      if (!json || json.error) return { error: 'chainlink_rpc_error' }
      return decodeLatestRoundData(json.result)
    } catch {
      return { error: 'chainlink_rpc_unavailable' }
    }
  }
}
