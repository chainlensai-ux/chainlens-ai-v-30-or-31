// MODULE 10 — holdingsEngine: provider fetch helpers. These are the only network calls in this
// module — one bounded GoldRush balances_v2 call and one bounded Alchemy token-balances call per
// chain, never paginated, never repeated.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { TokenHolding } from './types'

const ALCHEMY_BASE_KEY_NAMES = ['ALCHEMY_BASE_KEY', 'ALCHEMY_BASE_API_KEY', 'BASE_ALCHEMY_API_KEY', 'ALCHEMY_API_KEY', 'NEXT_PUBLIC_ALCHEMY_BASE_KEY']
const ALCHEMY_ETH_KEY_NAMES = ['ALCHEMY_ETHEREUM_KEY', 'ALCHEMY_ETH_KEY', 'ALCHEMY_ETH_API_KEY', 'ALCHEMY_API_KEY']

function resolveEnvKey(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim().length > 0) return value.trim()
  }
  return ''
}

function goldrushApiKey(): string {
  return process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
}

function alchemyApiKey(chain: SupportedChain): string {
  return chain === 'eth' ? resolveEnvKey(ALCHEMY_ETH_KEY_NAMES) : resolveEnvKey(ALCHEMY_BASE_KEY_NAMES)
}

function alchemyBaseUrl(chain: SupportedChain): string {
  const key = alchemyApiKey(chain)
  const network = chain === 'eth' ? 'eth-mainnet' : 'base-mainnet'
  return `https://${network}.g.alchemy.com/v2/${key}`
}

function goldrushChainName(chain: SupportedChain): string {
  return chain === 'eth' ? 'eth-mainnet' : 'base-mainnet'
}

export async function fetchGoldrushHoldings(chain: SupportedChain, walletAddress: string): Promise<{ ok: boolean; holdings: TokenHolding[] }> {
  const apiKey = goldrushApiKey()
  if (!apiKey) return { ok: false, holdings: [] }
  try {
    const url = `https://api.covalenthq.com/v1/${goldrushChainName(chain)}/address/${walletAddress}/balances_v2/?no-spam=true&no-nft-fetch=true`
    const res = await fetch(url, { cache: 'no-store', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false, holdings: [] }
    const json = await res.json()
    if (json?.error) return { ok: false, holdings: [] }
    const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items : []

    const holdings: TokenHolding[] = items
      .map((item) => {
        const it = item as Record<string, unknown>
        const decimals = typeof it.contract_decimals === 'number' ? it.contract_decimals : 18
        const rawBalance = String(it.balance ?? '0')
        const amount = parseFloat(rawBalance) / Math.pow(10, decimals)
        const providerPriceUsd = typeof it.quote_rate === 'number' && it.quote_rate > 0 ? it.quote_rate : null
        const providerValueUsd = typeof it.quote === 'number' ? it.quote : null
        return {
          chain,
          contract: typeof it.contract_address === 'string' ? it.contract_address.toLowerCase() : '',
          symbol: typeof it.contract_ticker_symbol === 'string' ? it.contract_ticker_symbol : '?',
          name: typeof it.contract_name === 'string' ? it.contract_name : null,
          amount,
          amountRaw: rawBalance,
          tokenDecimals: decimals,
          providerPriceUsd,
          providerValueUsd,
        } satisfies TokenHolding
      })
      .filter((h) => h.contract.startsWith('0x') && Number.isFinite(h.amount) && h.amount > 0)

    return { ok: true, holdings }
  } catch {
    return { ok: false, holdings: [] }
  }
}

export async function fetchAlchemyHoldings(chain: SupportedChain, walletAddress: string): Promise<{ ok: boolean; holdings: TokenHolding[] }> {
  const apiKey = alchemyApiKey(chain)
  if (!apiKey) return { ok: false, holdings: [] }
  try {
    const res = await fetch(alchemyBaseUrl(chain), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params: [walletAddress, 'erc20'] }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, holdings: [] }
    const json = await res.json()
    const tokenBalances: unknown[] = Array.isArray(json?.result?.tokenBalances) ? json.result.tokenBalances : []

    // Alchemy's raw balance call has no symbol/decimals/price metadata without an extra
    // per-token call — deliberately not made here (bounded cost). Amount/symbol stay honestly
    // best-effort; portfolioAssembler treats a missing price as null, never a guess.
    const holdings: TokenHolding[] = tokenBalances
      .map((tb) => {
        const t = tb as Record<string, unknown>
        const contract = typeof t.contractAddress === 'string' ? t.contractAddress.toLowerCase() : ''
        const rawHex = typeof t.tokenBalance === 'string' ? t.tokenBalance : '0x0'
        const rawDecimal = BigInt(rawHex === '0x' ? '0x0' : rawHex).toString()
        const amount = parseFloat(rawDecimal) / Math.pow(10, 18) // decimals unknown without a metadata call; 18 is the common default
        return {
          chain,
          contract,
          symbol: '?',
          name: null,
          amount,
          amountRaw: rawDecimal,
          tokenDecimals: 18,
          providerPriceUsd: null,
          providerValueUsd: null,
        } satisfies TokenHolding
      })
      .filter((h) => h.contract.startsWith('0x') && Number.isFinite(h.amount) && h.amount > 0)

    return { ok: true, holdings }
  } catch {
    return { ok: false, holdings: [] }
  }
}

export function dedupeHoldingsKey(holding: TokenHolding): string {
  return `${holding.chain}:${holding.contract.toLowerCase()}`
}
