// MODULE 5 — recoveryPolicy: pure helpers + the module's own isolated fetch functions.
//
// The two fetch helpers below are the ONLY network calls in this module. They are intentionally
// self-contained (not imported from providerFetchWindow/utils.ts, which is not exported for reuse
// and is semantically different — a whole-wallet base-window pull vs. a single-token targeted
// historical page) so this module has no runtime coupling to module 1's internals.

import type { BuyTimelineEntry } from '../timelineBuilder/types'
import type { SellTimelineEntry } from '../timelineBuilder/types'
import type { RawProviderEvent, SupportedChain } from '../providerFetchWindow/types'
import type { HoldingInput, RecoveryTriggerEvidenceRef } from './types'

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

// Targeted GoldRush historical page — page-number offset beyond the base window's page 0. Caller
// (index.ts) is responsible for enforcing the page cap; this function fetches exactly one page.
export async function fetchGoldrushHistoricalPage(
  chain: SupportedChain,
  walletAddress: string,
  pageNumber: number,
): Promise<RawProviderEvent[]> {
  const apiKey = goldrushApiKey()
  if (!apiKey) return []
  try {
    const url = new URL(`https://api.covalenthq.com/v1/${goldrushChainName(chain)}/address/${walletAddress}/transactions_v3/`)
    url.searchParams.set('page-size', '100')
    url.searchParams.set('page-number', String(pageNumber))
    url.searchParams.set('with-logs', 'true')
    url.searchParams.set('no-spam', 'true')
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return []
    const json = await res.json()
    const items: unknown[] = Array.isArray(json?.data?.items) ? json.data.items : []
    const events: RawProviderEvent[] = []
    for (const it of items) {
      const tx = it as Record<string, unknown>
      const txHash = typeof tx.tx_hash === 'string' ? tx.tx_hash : null
      const timestamp = typeof tx.block_signed_at === 'string' ? tx.block_signed_at : null
      const transfers: unknown[] = Array.isArray(tx.transfers) ? tx.transfers : []
      for (const transfer of transfers.slice(0, 12)) {
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
    }
    return events
  } catch {
    return []
  }
}

// Targeted Alchemy pull scoped to a single token contract (contractAddresses filter) — never a
// whole-wallet pull, keeping this genuinely "targeted historical recovery for this token only".
export async function fetchAlchemyTokenHistory(
  chain: SupportedChain,
  walletAddress: string,
  token: string,
): Promise<RawProviderEvent[]> {
  const apiKey = alchemyApiKey(chain)
  if (!apiKey) return []
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
      rpc({ fromBlock: '0x0', category: ['erc20'], contractAddresses: [token], withMetadata: true, maxCount: '0x64', order: 'desc', fromAddress: walletAddress }),
      rpc({ fromBlock: '0x0', category: ['erc20'], contractAddresses: [token], withMetadata: true, maxCount: '0x64', order: 'desc', toAddress: walletAddress }),
    ])
    const events: RawProviderEvent[] = []
    const collect = (result: Record<string, unknown> | null) => {
      const transfers = Array.isArray(result?.transfers) ? (result!.transfers as Record<string, unknown>[]) : []
      for (const t of transfers) {
        const meta = t.metadata as Record<string, unknown> | undefined
        events.push({
          provider: 'alchemy',
          chain,
          txHash: typeof t.hash === 'string' ? t.hash : null,
          timestamp: typeof meta?.blockTimestamp === 'string' ? meta.blockTimestamp : null,
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
    return events
  } catch {
    return []
  }
}

// PURE. Distinct (chain, token) pairs referenced by buyTimeline + sellTimeline ONLY — never
// distributionTimeline (Architecture Step 3 §2 / Step 9 §7: distributions can never trigger
// recovery, enforced structurally by this function simply never being given that timeline).
export function distinctTokensFromTimelines(
  buyEntries: BuyTimelineEntry[],
  sellEntries: SellTimelineEntry[],
): Array<{ token: string; chain: SupportedChain }> {
  const seen = new Map<string, { token: string; chain: SupportedChain }>()
  for (const e of buyEntries) seen.set(`${e.chain}:${e.token.toLowerCase()}`, { token: e.token.toLowerCase(), chain: e.chain })
  for (const e of sellEntries) seen.set(`${e.chain}:${e.token.toLowerCase()}`, { token: e.token.toLowerCase(), chain: e.chain })
  return [...seen.values()]
}

// PURE. Cumulative buy-side USD value for a token, from whatever usdValueEstimate figures are
// already present on buyTimeline entries (never invented here — entries with a null estimate
// simply contribute 0 to the sum, they are never guessed at).
export function cumulativeBuyValueUsd(buyEntries: BuyTimelineEntry[], token: string, chain: SupportedChain): number {
  return buyEntries
    .filter((e) => e.chain === chain && e.token.toLowerCase() === token.toLowerCase())
    .reduce((sum, e) => sum + (e.usdValueEstimate ?? 0), 0)
}

// PURE. Sell-timeline occurrence count for a token — feeds the repeated-sell trigger rule.
export function sellOccurrenceCount(sellEntries: SellTimelineEntry[], token: string, chain: SupportedChain): number {
  return sellEntries.filter((e) => e.chain === chain && e.token.toLowerCase() === token.toLowerCase()).length
}

// PURE. Top-3 holdings by USD value, from caller-supplied holdings input (no portfolio-pricing
// module exists in this delivery — see types.ts HoldingInput doc).
export function top3HoldingTokens(holdings: HoldingInput[]): Set<string> {
  const sorted = [...holdings].sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 3)
  return new Set(sorted.map((h) => `${h.chain}:${h.token.toLowerCase()}`))
}

export function evidenceRefsFor(entries: Array<{ txHash: string; timestamp: number }>): RecoveryTriggerEvidenceRef[] {
  return entries.map((e) => ({ txHash: e.txHash, timestamp: e.timestamp }))
}
