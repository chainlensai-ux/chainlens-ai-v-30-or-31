// Which tracked wallets are real accounts worth scanning. A router, bridge or other contract in the
// tracked set produces nothing but routing noise, so sync skips it.
//  - KNOWN_INFRA_ADDRESSES: Base infrastructure we are certain of (routers, bridge predeploys,
//    burn addresses). Kept deliberately short — an address is only listed when verified.
//  - Contract detection: eth_getCode. Plain EOAs return "0x"; EIP-7702 delegated EOAs return the
//    0xef0100 delegation designator and are still people, so they are scanned. A failed lookup is
//    "unknown" and the wallet is scanned — a provider hiccup must never silently drop a wallet.

export const KNOWN_INFRA_ADDRESSES: ReadonlyMap<string, string> = new Map([
  ['0x0000000000000000000000000000000000000000', 'zero address'],
  ['0x000000000000000000000000000000000000dead', 'burn address'],
  ['0x1111111111166b7fe7bd91427724b487980afc69', '1inch router'],
  ['0x111111125421ca6dc452d289314280a0f8842a65', '1inch router v6'],
  ['0x1111111254eeb25477b68fb85ed929f73a960582', '1inch router v5'],
  ['0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', 'Uniswap Universal Router'],
  ['0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', 'Aerodrome router'],
  ['0x4200000000000000000000000000000000000010', 'Base L2 standard bridge'],
  ['0x4200000000000000000000000000000000000016', 'Base L2-to-L1 message passer'],
  ['0x4200000000000000000000000000000000000006', 'WETH contract'],
])

/** Mint/burn counterparties: a transfer from/to these is a mint or burn, not a trade with someone. */
export const MINT_BURN_ADDRESSES: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
])

export type WalletKind = 'eoa' | 'contract' | 'infra' | 'unknown'

const CODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const codeCache = new Map<string, { kind: 'eoa' | 'contract'; expiresAt: number }>()

export function classifyCode(code: unknown): 'eoa' | 'contract' | 'unknown' {
  if (typeof code !== 'string' || !code.startsWith('0x')) return 'unknown'
  if (code === '0x' || code === '0x0') return 'eoa'
  if (code.toLowerCase().startsWith('0xef0100')) return 'eoa' // EIP-7702 delegated EOA
  return 'contract'
}

function baseRpcUrl(): string {
  const explicit = process.env.ALCHEMY_BASE_RPC_URL ?? process.env.BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY ?? process.env.ALCHEMY_API_KEY
  return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : 'https://mainnet.base.org'
}

type RpcFetch = (url: string, init: RequestInit) => Promise<Response>

/** One JSON-RPC batch for all uncached addresses; cached for a day. Never throws. */
export async function classifyWallets(
  addresses: readonly string[],
  fetchImpl: RpcFetch = fetch,
  now = Date.now(),
): Promise<Map<string, WalletKind>> {
  const out = new Map<string, WalletKind>()
  const lookup: string[] = []
  for (const raw of addresses) {
    const address = raw.toLowerCase()
    if (KNOWN_INFRA_ADDRESSES.has(address)) { out.set(address, 'infra'); continue }
    const cached = codeCache.get(address)
    if (cached && cached.expiresAt > now) { out.set(address, cached.kind); continue }
    lookup.push(address)
  }
  if (lookup.length === 0) return out
  try {
    const res = await fetchImpl(baseRpcUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lookup.map((address, id) => ({ jsonrpc: '2.0', id, method: 'eth_getCode', params: [address, 'latest'] }))),
      signal: AbortSignal.timeout(4_000),
    })
    const json = res.ok ? await res.json().catch(() => null) : null
    const results = Array.isArray(json) ? json as Array<{ id?: number; result?: unknown }> : []
    const byId = new Map(results.map(r => [r.id, r.result]))
    lookup.forEach((address, id) => {
      const kind = classifyCode(byId.get(id))
      out.set(address, kind)
      if (kind !== 'unknown') codeCache.set(address, { kind, expiresAt: now + CODE_CACHE_TTL_MS })
    })
  } catch {
    for (const address of lookup) out.set(address, 'unknown')
  }
  return out
}

/** Test-only. */
export function __resetWalletKindCacheForTest(): void { codeCache.clear() }
