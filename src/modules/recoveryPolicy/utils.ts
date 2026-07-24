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
import { logRpcCall } from '@/lib/server/rpcDebug'
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

// HyperEVM is deliberately absent from both maps below — no codebase-verified GoldRush/Alchemy
// slug exists for it (see providerFetchWindow/types.ts's TODO). Recovery for a HyperEVM
// (chain, token) pair honestly fetches zero historical events rather than guessing a URL.
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

// REQUEST-SCOPED PROMISE COALESCING, DISCLOSED (provider-call-audit follow-up, CONFIRMED root cause
// of the "4 Base transactions_v3 calls" symptom surviving the earlier fetchProviderWindow-level
// fix): this function's URL depends ONLY on (chain, walletAddress, pageNumber) — it has NO token
// parameter, and fetchHistoricalPages (index.ts) already filters the SAME returned events down to
// one candidate's token AFTER the fact (`goldrushEvents.filter(e => e.contract === token)`). But
// buildRecoveryPolicyObject calls fetchHistoricalPages ONCE PER TRIGGERED CANDIDATE (up to
// RECOVERY_CANDIDATE_CONCURRENCY_LIMIT=2 concurrently, up to maxHistoricalPagesPerWallet candidates
// total) — every one of those candidates on the SAME chain was independently firing this exact same
// byte-for-byte GoldRush request (same wallet, same chain, same page-number=1), each burning a real
// 12s-capped Covalent call for data that was already fetched, or being fetched, by another candidate
// on the same chain. That directly explains a Base wallet with 2-3 triggered candidates producing
// 2-3 duplicate "Base transactions_v3" calls in addition to the (already-coalesced)
// fetchProviderWindow window fetch — bypassing that coalescer entirely, since this is a completely
// separate module/function never routed through it (this module is intentionally self-contained,
// per this file's own header). Fixed the same way fetchProviderWindow was: the first candidate for
// a given (chain, wallet, pageNumber) starts the real fetch; every other candidate reusing the same
// key gets the identical in-flight/settled result and does its own token-filtering locally — same
// real events either way, zero new network calls. NOT a persistent/Redis cache layer — purely an
// in-process map, reset once per scan job alongside providerFetchWindow's own reset (see
// resetRecoveryHistoricalPageRequestCache, called from walletScanWorker.ts).
const requestScopedHistoricalPages = new Map<string, Promise<RawProviderEvent[]>>()

export function resetRecoveryHistoricalPageRequestCache(): void {
  requestScopedHistoricalPages.clear()
}

// Targeted GoldRush historical page — page-number offset beyond the base window's page 0. Caller
// (index.ts) is responsible for enforcing the page cap; this function fetches exactly one page.
export async function fetchGoldrushHistoricalPage(
  chain: SupportedChain,
  walletAddress: string,
  pageNumber: number,
): Promise<RawProviderEvent[]> {
  const key = `${chain}:${walletAddress.trim().toLowerCase()}:${pageNumber}`
  const existing = requestScopedHistoricalPages.get(key)
  if (existing) return existing

  const promise = fetchGoldrushHistoricalPageLive(chain, walletAddress, pageNumber)
  requestScopedHistoricalPages.set(key, promise)
  // Defensive cleanup only: fetchGoldrushHistoricalPageLive is disclosed as never throwing (every
  // failure path below resolves to []) — guards against that contract ever being violated by a
  // future change, so an unexpected rejection can't permanently poison this key for the rest of the
  // request.
  promise.catch(() => { if (requestScopedHistoricalPages.get(key) === promise) requestScopedHistoricalPages.delete(key) })
  return promise
}

async function fetchGoldrushHistoricalPageLive(
  chain: SupportedChain,
  walletAddress: string,
  pageNumber: number,
): Promise<RawProviderEvent[]> {
  const chainSlug = goldrushChainName(chain)
  if (!chainSlug) return []
  const apiKey = goldrushApiKey()
  if (!apiKey) return []
  try {
    const url = new URL(`https://api.covalenthq.com/v1/${chainSlug}/address/${walletAddress}/transactions_v3/`)
    url.searchParams.set('page-size', '100')
    url.searchParams.set('page-number', String(pageNumber))
    url.searchParams.set('with-logs', 'true')
    url.searchParams.set('no-spam', 'true')
    logRpcCall({ route: 'recoveryPolicy', chain, method: 'goldrush_transactions_v3_historical' })
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
  const url = alchemyBaseUrl(chain)
  if (!url) return []
  const apiKey = alchemyApiKey(chain)
  if (!apiKey) return []
  const rpc = async (params: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      logRpcCall({ route: 'recoveryPolicy', chain, method: 'alchemy_getAssetTransfers' })
      auditRPC('alchemy_getAssetTransfers', params)
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
