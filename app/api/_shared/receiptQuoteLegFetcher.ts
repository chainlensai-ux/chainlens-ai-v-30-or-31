// app/api/_shared/receiptQuoteLegFetcher.ts — bounded, real eth_getTransactionReceipt fetch for the
// wallet-scanner PnL quote-leg-recovery fix (see src/modules/swapNormalizer/quoteLegRecovery.ts's
// own header for the full root-cause disclosure this closes).
//
// SCOPE, DISCLOSED: covers 'eth' and 'base' only — the two chains lib/engine/modules/pnl/
// computePnl.ts's fetchParsedTrades already supports (CHAIN_ID_TO_SUPPORTED_CHAIN). Same
// ALCHEMY_BASE_RPC_URL/ALCHEMY_BASE_KEY convention already verified and shipped in basedex.ts and
// src/modules/receiptSwapDecoder/rpcClient.ts; the eth equivalent mirrors app/api/token/route.ts's
// own getAlchemyRpcUrl env-var names (ETH_RPC_URL / ALCHEMY_ETHEREUM_KEY) so no new env var naming
// convention is introduced.
//
// BOUNDED, DISCLOSED: a real network call per invocation, capped by the caller via CuBudget's
// existing maxProviderCalls (the same shared per-scan budget every other provider call in this
// codebase already respects — see cuBudget.ts) — this module does not introduce a second, separate
// budget. No retries; a failed/timed-out/reverted fetch degrades to `null` (never fabricated logs),
// exactly the "fail-closed" convention already established in src/modules/receiptSwapDecoder/
// receiptAcquisition.ts's own header for the exact same kind of call.

import { recordProviderCall, type CuBudget } from './cuBudget'
import type { RawReceiptLog } from '@/src/modules/swapNormalizer/quoteLegRecovery'

const DEFAULT_TIMEOUT_MS = 4000

function receiptRpcUrl(chain: 'eth' | 'base'): string | null {
  if (chain === 'eth') {
    const explicit = process.env.ETH_RPC_URL
    if (explicit && /^https?:\/\//.test(explicit)) return explicit
    const key = process.env.ALCHEMY_ETHEREUM_KEY
    return key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : null
  }
  const explicit = process.env.BASE_RPC_URL ?? process.env.ALCHEMY_BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY
  if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
  return 'https://mainnet.base.org'
}

type RawJsonRpcLog = {
  logIndex?: string
  address?: string
  topics?: string[]
  data?: string
  removed?: boolean
}

function toReceiptLog(raw: RawJsonRpcLog): RawReceiptLog | null {
  if (!raw.address || !Array.isArray(raw.topics) || typeof raw.data !== 'string') return null
  if (raw.removed) return null // reorg'd-out log — never treated as real evidence
  const logIndex = typeof raw.logIndex === 'string' ? Number.parseInt(raw.logIndex, 16) : 0
  return { logIndex: Number.isFinite(logIndex) ? logIndex : 0, address: raw.address, topics: raw.topics, data: raw.data }
}

export type ReceiptLogsOutcome =
  | { status: 'ok'; logs: RawReceiptLog[] }
  | { status: 'missing' }
  | { status: 'reverted' }
  | { status: 'not_configured' }
  | { status: 'error'; reason: string }

// A single real eth_getTransactionReceipt call. Never throws — every failure mode (no RPC
// configured, network error, timeout, malformed response, reverted tx) resolves to its own honest
// outcome instead. `cuBudget`, when passed, records this as one real provider call against the
// same shared per-scan budget every other provider call already uses.
export async function fetchTransactionReceiptLogs(chain: 'eth' | 'base', txHash: string, cuBudget?: CuBudget, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ReceiptLogsOutcome> {
  const url = receiptRpcUrl(chain)
  if (!url) return { status: 'not_configured' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (cuBudget) recordProviderCall(cuBudget)
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
    })
    if (!res.ok) return { status: 'error', reason: `http_${res.status}` }
    const json = await res.json().catch(() => null) as { result?: unknown; error?: { message?: string } } | null
    if (!json) return { status: 'error', reason: 'invalid_json' }
    if (json.error) return { status: 'error', reason: json.error.message ?? 'rpc_error' }
    const result = json.result as { status?: string; logs?: RawJsonRpcLog[] } | null | undefined
    if (!result) return { status: 'missing' }
    if (result.status === '0x0') return { status: 'reverted' }
    if (!Array.isArray(result.logs)) return { status: 'missing' }
    const logs = result.logs.map(toReceiptLog).filter((l): l is RawReceiptLog => l !== null)
    return { status: 'ok', logs }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return { status: 'error', reason: isTimeout ? 'timeout' : (err instanceof Error ? err.message : String(err)) }
  } finally {
    clearTimeout(timeout)
  }
}
