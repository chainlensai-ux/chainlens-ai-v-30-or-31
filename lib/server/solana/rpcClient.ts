// SOLANA RPC CLIENT, DISCLOSED (Solana-native architecture task): shared JSON-RPC transport for
// every analyzer in lib/server/solana/*. One place owns retry/timeout policy so every analyzer
// gets the same reliability guarantees instead of each reimplementing fetch/timeout/retry.

export type RpcFetch = typeof fetch

// RELIABILITY FIX, DISCLOSED: a live comparison of two back-to-back scans of the SAME mint showed
// getTokenLargestAccounts resolve once and then report "unavailable" moments later — with zero
// retry, a single transient Alchemy hiccup (429 rate limit, brief timeout, momentary 5xx) silently
// downgraded the whole scan to an evidence gap, which reads as "Solana holders are broken" even
// though the RPC itself is healthy. This retries once, only for failure classes that are plausibly
// transient (never for a clean JSON-RPC error message, which is a real answer from the node, not a
// hiccup) — still counts as a single logical RPC attempt for the audit, and still degrades to an
// honest evidence gap (never a fabricated value) if the retry also fails.
const SOLANA_RPC_TRANSIENT_ERRORS = new Set(['rpc_bad_json', 'rpc_null_result', 'rpc_unreachable'])
function isTransientSolanaRpcError(error: string): boolean {
  if (SOLANA_RPC_TRANSIENT_ERRORS.has(error)) return true
  if (error.startsWith('rpc_http_')) {
    const status = Number(error.slice('rpc_http_'.length))
    return status === 429 || (status >= 500 && status < 600)
  }
  return false
}

async function solanaRpcOnce<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: RpcFetch,
  timeoutMs: number,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}` }
    const json = await res.json().catch(() => null) as { result?: T; error?: { message?: string } } | null
    if (!json) return { ok: false, error: 'rpc_bad_json' }
    if (json.error) return { ok: false, error: `rpc_error:${json.error.message ?? 'unknown'}` }
    if (json.result === undefined || json.result === null) return { ok: false, error: 'rpc_null_result' }
    return { ok: true, result: json.result }
  } catch {
    return { ok: false, error: 'rpc_unreachable' }
  }
}

/** One retry, only for plausibly-transient failures. See this module's own header. */
export async function solanaRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: RpcFetch,
  timeoutMs = 9000,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const first = await solanaRpcOnce<T>(rpcUrl, method, params, fetchImpl, timeoutMs)
  if (first.ok || !isTransientSolanaRpcError(first.error)) return first
  await new Promise((resolve) => setTimeout(resolve, 350))
  return solanaRpcOnce<T>(rpcUrl, method, params, fetchImpl, timeoutMs)
}
