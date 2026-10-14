// EXIT evidence: after a SELL, read the wallet's current on-chain balance of the sold token. Zero
// balance → the wallet has exited the position. One JSON-RPC batch per feed request, capped, cached
// for 10 minutes. Any lookup failure leaves the row a plain SELL (never guessed).

const EXIT_CACHE_TTL_MS = 10 * 60 * 1000
export const MAX_EXIT_CHECKS_PER_REQUEST = 20
const exitCache = new Map<string, { zero: boolean; expiresAt: number }>()

function baseRpcUrl(): string {
  const explicit = process.env.ALCHEMY_BASE_RPC_URL ?? process.env.BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY ?? process.env.ALCHEMY_API_KEY
  return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : 'https://mainnet.base.org'
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/

/** balanceOf(address) calldata. */
export function balanceOfCalldata(wallet: string): string {
  return `0x70a08231${wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
}

type RpcFetch = (url: string, init: RequestInit) => Promise<Response>

/** Map of `${wallet}:${token}` → true when the current balance is exactly zero. */
export async function checkZeroBalances(
  pairs: ReadonlyArray<{ wallet: string; token: string }>,
  fetchImpl: RpcFetch = fetch,
  now = Date.now(),
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  const lookup: Array<{ key: string; wallet: string; token: string }> = []
  for (const pair of pairs) {
    const wallet = pair.wallet.toLowerCase()
    const token = pair.token.toLowerCase()
    if (!ADDRESS_RE.test(wallet) || !ADDRESS_RE.test(token)) continue
    const key = `${wallet}:${token}`
    if (out.has(key) || lookup.some(l => l.key === key)) continue
    const cached = exitCache.get(key)
    if (cached && cached.expiresAt > now) { out.set(key, cached.zero); continue }
    if (lookup.length < MAX_EXIT_CHECKS_PER_REQUEST) lookup.push({ key, wallet, token })
  }
  if (lookup.length === 0) return out
  try {
    const res = await fetchImpl(baseRpcUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lookup.map((l, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: l.token, data: balanceOfCalldata(l.wallet) }, 'latest'] }))),
      signal: AbortSignal.timeout(4_000),
    })
    const json = res.ok ? await res.json().catch(() => null) : null
    const results = Array.isArray(json) ? json as Array<{ id?: number; result?: unknown }> : []
    const byId = new Map(results.map(r => [r.id, r.result]))
    lookup.forEach((l, id) => {
      const raw = byId.get(id)
      if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) return
      const zero = BigInt(raw) === BigInt(0)
      out.set(l.key, zero)
      exitCache.set(l.key, { zero, expiresAt: now + EXIT_CACHE_TTL_MS })
    })
  } catch {
    // Unknown stays unknown: rows remain SELL.
  }
  return out
}

/** Test-only. */
export function __resetExitCacheForTest(): void { exitCache.clear() }
