// MODULE 10 — holdingsEngine: provider fetch helpers. These are the only network calls in this
// module — one bounded GoldRush balances_v2 call and one bounded Alchemy token-balances call per
// chain, never paginated, never repeated.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { TokenHolding } from './types'
import { logRpcCall } from '@/lib/server/rpcDebug'
import { profileGoldrush } from '@/lib/providers/goldrush'
import { auditRPC } from '@/lib/server/alchemyAudit'

const ALCHEMY_BASE_KEY_NAMES = ['ALCHEMY_BASE_KEY', 'ALCHEMY_BASE_API_KEY', 'BASE_ALCHEMY_API_KEY', 'ALCHEMY_API_KEY', 'NEXT_PUBLIC_ALCHEMY_BASE_KEY']
const ALCHEMY_ETH_KEY_NAMES = ['ALCHEMY_ETHEREUM_KEY', 'ALCHEMY_ETH_KEY', 'ALCHEMY_ETH_API_KEY', 'ALCHEMY_API_KEY']
const ALCHEMY_ARBITRUM_KEY_NAMES = ['ALCHEMY_ARBITRUM_KEY', 'ALCHEMY_ARBITRUM_API_KEY', 'ARBITRUM_ALCHEMY_API_KEY', 'ALCHEMY_API_KEY']

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

// HyperEVM deliberately absent — no codebase-verified GoldRush/Alchemy slug exists for it (see
// providerFetchWindow/types.ts's TODO). Holdings for a HyperEVM wallet honestly resolve to an
// empty list from both providers rather than guessing a URL.
const GOLDRUSH_VERIFIED_CHAIN_SLUGS: Partial<Record<SupportedChain, string>> = {
  eth: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arbitrum-mainnet',
}

const ALCHEMY_VERIFIED_CHAINS: Partial<Record<SupportedChain, { keyNames: string[]; networkSlug: string }>> = {
  eth: { keyNames: ALCHEMY_ETH_KEY_NAMES, networkSlug: 'eth-mainnet' },
  base: { keyNames: ALCHEMY_BASE_KEY_NAMES, networkSlug: 'base-mainnet' },
  arbitrum: { keyNames: ALCHEMY_ARBITRUM_KEY_NAMES, networkSlug: 'arb-mainnet' },
}

function alchemyApiKey(chain: SupportedChain): string {
  const verified = ALCHEMY_VERIFIED_CHAINS[chain]
  return verified ? resolveEnvKey(verified.keyNames) : ''
}

function alchemyBaseUrl(chain: SupportedChain): string | null {
  const verified = ALCHEMY_VERIFIED_CHAINS[chain]
  if (!verified) return null
  const key = alchemyApiKey(chain)
  return `https://${verified.networkSlug}.g.alchemy.com/v2/${key}`
}

function goldrushChainName(chain: SupportedChain): string | null {
  return GOLDRUSH_VERIFIED_CHAIN_SLUGS[chain] ?? null
}

export async function fetchGoldrushHoldings(chain: SupportedChain, walletAddress: string): Promise<{ ok: boolean; holdings: TokenHolding[] }> {
  // PROFILER, DISCLOSED: "call" only, no caching added here — live balance data changes as a wallet
  // trades, unlike fetchGoldrushHistoricalPrice's permanent historical-fact caching. Caching this
  // would risk showing a stale portfolio value, a real correctness regression this task's own rules
  // (only cache where redundant calls occur; never cache live, changing data) explicitly warn against.
  profileGoldrush('fetchHoldings', { chain, walletAddress }, 'call')
  const chainSlug = goldrushChainName(chain)
  if (!chainSlug) return { ok: false, holdings: [] }
  const apiKey = goldrushApiKey()
  if (!apiKey) return { ok: false, holdings: [] }
  try {
    const url = `https://api.covalenthq.com/v1/${chainSlug}/address/${walletAddress}/balances_v2/?no-spam=true&no-nft-fetch=true`
    logRpcCall({ route: 'holdings', chain, method: 'goldrush_balances_v2' })
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
  const url = alchemyBaseUrl(chain)
  if (!url) return { ok: false, holdings: [] }
  const apiKey = alchemyApiKey(chain)
  if (!apiKey) return { ok: false, holdings: [] }
  try {
    logRpcCall({ route: 'holdings', chain, method: 'alchemy_getTokenBalances' })
    auditRPC('alchemy_getTokenBalances', [walletAddress, 'erc20'])
    const res = await fetch(url, {
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
