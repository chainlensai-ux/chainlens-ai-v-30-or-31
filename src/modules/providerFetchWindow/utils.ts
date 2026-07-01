// MODULE 1 — providerFetchWindow: provider-specific fetch helpers.
// These are the ONLY functions in the entire /src/modules tree permitted to make a network call
// (Architecture Step 8 §1/§3: "no component except recoveryPolicy triggers fetches" — at this
// foundation stage, recoveryPolicy does not exist yet, so providerFetchWindow is the sole fetch
// point). Every other module in this tree is a pure transform over already-fetched data.

import type {
  RawProviderEvent,
  SingleProviderFetchResult,
  SupportedChain,
} from './types'
import {
  MAX_RAW_EVENTS_PER_PROVIDER,
  PROVIDER_FETCH_WINDOW_DAYS_DEFAULT,
  PROVIDER_FETCH_WINDOW_DAYS_MAX,
  PROVIDER_FETCH_WINDOW_DAYS_MIN,
} from './types'

// Env var resolution mirrors the project's existing convention (multiple accepted names, server
// vars checked before NEXT_PUBLIC_*). This module intentionally does not import from
// lib/server/walletSnapshot.ts — it is a standalone foundation module with its own key
// resolution, so it has no dependency on (and cannot be broken by changes to) the legacy scanner.
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

// Alchemy needs both a per-chain key and a per-chain URL slug (unlike GoldRush, whose key is
// chain-agnostic — only its URL slug varies). Every chain this module supports must have an entry
// in both alchemyApiKey and alchemyBaseUrl/goldrushChainName below.
function alchemyApiKey(chain: SupportedChain): string {
  if (chain === 'eth') return resolveEnvKey(ALCHEMY_ETH_KEY_NAMES)
  if (chain === 'arbitrum') return resolveEnvKey(ALCHEMY_ARBITRUM_KEY_NAMES)
  return resolveEnvKey(ALCHEMY_BASE_KEY_NAMES)
}

function alchemyNetworkSlug(chain: SupportedChain): string {
  if (chain === 'eth') return 'eth-mainnet'
  if (chain === 'arbitrum') return 'arb-mainnet'
  return 'base-mainnet'
}

function alchemyBaseUrl(chain: SupportedChain): string {
  const key = alchemyApiKey(chain)
  return `https://${alchemyNetworkSlug(chain)}.g.alchemy.com/v2/${key}`
}

function goldrushChainName(chain: SupportedChain): string {
  if (chain === 'eth') return 'eth-mainnet'
  if (chain === 'arbitrum') return 'arbitrum-mainnet'
  return 'base-mainnet'
}

export function clampWindowDays(days?: number): number {
  const value = typeof days === 'number' && Number.isFinite(days) ? days : PROVIDER_FETCH_WINDOW_DAYS_DEFAULT
  return Math.max(PROVIDER_FETCH_WINDOW_DAYS_MIN, Math.min(PROVIDER_FETCH_WINDOW_DAYS_MAX, value))
}

function windowCutoffMs(windowDays: number): number {
  return Date.now() - windowDays * 24 * 60 * 60 * 1000
}

// Fetches a SINGLE bounded page from GoldRush (Covalent) transactions_v3. Never pages further —
// "never deep-page" (Architecture Step 1/8). Never throws: any failure resolves to
// { ok: false, events: [], errorReason }.
export async function fetchGoldrushRawEvents(
  chain: SupportedChain,
  walletAddress: string,
  windowDays: number,
): Promise<SingleProviderFetchResult> {
  const apiKey = goldrushApiKey()
  if (!apiKey) {
    return { provider: 'goldrush', ok: false, events: [], errorReason: 'no_api_key_configured' }
  }
  try {
    const url = new URL(`https://api.covalenthq.com/v1/${goldrushChainName(chain)}/address/${walletAddress}/transactions_v3/`)
    url.searchParams.set('page-size', '200')
    url.searchParams.set('page-number', '0')
    url.searchParams.set('with-logs', 'true')
    url.searchParams.set('no-spam', 'true')
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return { provider: 'goldrush', ok: false, events: [], errorReason: `http_${res.status}` }
    const json = await res.json()
    const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items : []
    const cutoff = windowCutoffMs(windowDays)
    const events: RawProviderEvent[] = []
    for (const it of items) {
      const tx = it as Record<string, unknown>
      const txHash = typeof tx.tx_hash === 'string' ? tx.tx_hash : null
      const timestamp = typeof tx.block_signed_at === 'string' ? tx.block_signed_at : null
      if (timestamp && Date.parse(timestamp) < cutoff) continue // shallow window only
      const transfers: unknown[] = Array.isArray(tx.transfers) ? tx.transfers : []
      for (const transfer of transfers.slice(0, 12)) {
        if (events.length >= MAX_RAW_EVENTS_PER_PROVIDER) break
        const tr = transfer as Record<string, unknown>
        events.push({
          provider: 'goldrush',
          chain,
          txHash,
          timestamp,
          fromAddress: typeof tr.from_address === 'string' ? tr.from_address.toLowerCase() : null,
          toAddress: typeof tr.to_address === 'string' ? tr.to_address.toLowerCase() : null,
          contract: typeof tr.contract_address === 'string' ? tr.contract_address.toLowerCase() : null,
          symbol: typeof tr.contract_ticker_symbol === 'string' ? tr.contract_ticker_symbol : null,
          amountRaw: typeof tr.delta === 'string' ? tr.delta : null,
          tokenDecimals: typeof tr.contract_decimals === 'number' ? tr.contract_decimals : null,
        })
      }
      if (events.length >= MAX_RAW_EVENTS_PER_PROVIDER) break
    }
    return { provider: 'goldrush', ok: true, events, errorReason: null }
  } catch (err) {
    return { provider: 'goldrush', ok: false, events: [], errorReason: err instanceof Error ? err.message : 'unknown_error' }
  }
}

// Fetches a SINGLE bounded pull from Alchemy (both from- and to-wallet batches, one page each).
// Never throws: any failure resolves to { ok: false, events: [], errorReason }.
export async function fetchAlchemyRawEvents(
  chain: SupportedChain,
  walletAddress: string,
  windowDays: number,
): Promise<SingleProviderFetchResult> {
  const apiKey = alchemyApiKey(chain)
  if (!apiKey) {
    return { provider: 'alchemy', ok: false, events: [], errorReason: 'no_api_key_configured' }
  }
  const url = alchemyBaseUrl(chain)
  const rpc = async (params: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
        signal: AbortSignal.timeout(12_000),
      })
      if (!res.ok) return null
      const json = await res.json()
      return (json?.result as Record<string, unknown>) ?? null
    } catch {
      return null
    }
  }
  try {
    const [fromResult, toResult] = await Promise.all([
      rpc({ fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0xC8', order: 'desc', fromAddress: walletAddress }),
      rpc({ fromBlock: '0x0', category: ['erc20'], withMetadata: true, maxCount: '0xC8', order: 'desc', toAddress: walletAddress }),
    ])
    if (!fromResult && !toResult) {
      return { provider: 'alchemy', ok: false, events: [], errorReason: 'no_usable_response' }
    }
    const cutoff = windowCutoffMs(windowDays)
    const events: RawProviderEvent[] = []
    const collect = (result: Record<string, unknown> | null) => {
      const transfers = Array.isArray(result?.transfers) ? (result!.transfers as Record<string, unknown>[]) : []
      for (const t of transfers) {
        if (events.length >= MAX_RAW_EVENTS_PER_PROVIDER) return
        const meta = t.metadata as Record<string, unknown> | undefined
        const timestamp = typeof meta?.blockTimestamp === 'string' ? meta.blockTimestamp : null
        if (timestamp && Date.parse(timestamp) < cutoff) continue // shallow window only
        events.push({
          provider: 'alchemy',
          chain,
          txHash: typeof t.hash === 'string' ? t.hash : null,
          timestamp,
          fromAddress: typeof t.from === 'string' ? t.from.toLowerCase() : null,
          toAddress: typeof t.to === 'string' ? (t.to as string).toLowerCase() : null,
          contract: typeof (t.rawContract as Record<string, unknown> | undefined)?.address === 'string'
            ? ((t.rawContract as Record<string, unknown>).address as string).toLowerCase()
            : null,
          symbol: typeof t.asset === 'string' ? t.asset : null,
          amountRaw: typeof (t.rawContract as Record<string, unknown> | undefined)?.value === 'string'
            ? ((t.rawContract as Record<string, unknown>).value as string)
            : null,
          tokenDecimals: null,
        })
      }
    }
    collect(fromResult)
    collect(toResult)
    return { provider: 'alchemy', ok: true, events, errorReason: null }
  } catch (err) {
    return { provider: 'alchemy', ok: false, events: [], errorReason: err instanceof Error ? err.message : 'unknown_error' }
  }
}

export function dedupeRawEventKey(event: RawProviderEvent): string {
  return `${event.txHash ?? ''}|${(event.contract ?? '').toLowerCase()}|${(event.fromAddress ?? '').toLowerCase()}|${(event.toAddress ?? '').toLowerCase()}|${event.amountRaw ?? ''}`
}
