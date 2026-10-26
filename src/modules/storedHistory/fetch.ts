// STORED WALLET HISTORY — Alchemy reader for one stream over an exact block range.
// Returns a FetchedSegment (core.ts); never throws. Budgeted: at most `maxPages` calls and a hard
// deadline; a 429 or any error stops the read (what was read stays, unclaimed beyond its proven part).

import { alchemyHexAmountToDecimalString, alchemyHexDecimalToNumber } from '@/src/modules/providerFetchWindow/utils'
import type { FetchedSegment, StoredTransfer, StreamKey } from './core'

export const STREAM_CATEGORIES: Record<StreamKey, string[]> = {
  from: ['erc20', 'external'],
  to: ['erc20', 'external'],
  toInternal: ['internal'],
}

/** Alchemy's maximum page size for alchemy_getAssetTransfers. */
export const STORED_HISTORY_PAGE_SIZE = 1000

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export type SegmentRequest = {
  url: string
  wallet: string
  stream: StreamKey
  mode: FetchedSegment['mode']
  fromBlock: number
  toBlock: number
  maxPages: number
  deadlineMs: number
  fetchImpl?: FetchLike
  now?: () => number
}

export type SegmentResult = FetchedSegment & { calls: number; stopReason: 'exhausted' | 'page_cap' | 'deadline' | 'rate_limited' | 'error' | 'unsupported' | null; error: string | null }

const hex = (n: number) => `0x${Math.max(0, Math.floor(n)).toString(16)}`

function parseBlock(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const n = Number.parseInt(v, 16)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Normalises one Alchemy transfer row; null when it lacks the fields the history depends on. */
export function toStoredTransfer(row: Record<string, unknown>, stream: StreamKey): StoredTransfer | null {
  const uid = typeof row.uniqueId === 'string' ? row.uniqueId : null
  const block = parseBlock(row.blockNum)
  if (!uid || block == null) return null
  const meta = row.metadata as Record<string, unknown> | undefined
  const raw = row.rawContract as Record<string, unknown> | undefined
  const category = typeof row.category === 'string' ? row.category : 'unknown'
  return {
    uid,
    block,
    ts: typeof meta?.blockTimestamp === 'string' ? meta.blockTimestamp : null,
    hash: typeof row.hash === 'string' ? row.hash.toLowerCase() : null,
    from: typeof row.from === 'string' ? row.from.toLowerCase() : null,
    to: typeof row.to === 'string' ? row.to.toLowerCase() : null,
    contract: category === 'erc20' && typeof raw?.address === 'string' ? raw.address.toLowerCase() : null,
    asset: typeof row.asset === 'string' ? row.asset : null,
    category,
    amountRaw: alchemyHexAmountToDecimalString(typeof raw?.value === 'string' ? raw.value : null),
    decimals: alchemyHexDecimalToNumber(typeof raw?.decimal === 'string' ? raw.decimal : null),
    stream,
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, { ...init, cache: 'no-store' } as RequestInit) as unknown as ReturnType<FetchLike>

/** Reads one stream over [fromBlock, toBlock]: asc for 'incremental', desc otherwise. */
export async function fetchStreamSegment(req: SegmentRequest): Promise<SegmentResult> {
  const now = req.now ?? Date.now
  const doFetch = req.fetchImpl ?? defaultFetch
  const order = req.mode === 'incremental' ? 'asc' : 'desc'
  const base: SegmentResult = { stream: req.stream, mode: req.mode, fromBlock: req.fromBlock, toBlock: req.toBlock, transfers: [], exhausted: false, calls: 0, stopReason: null, error: null }
  if (req.toBlock < req.fromBlock) return { ...base, exhausted: true, stopReason: 'exhausted' }
  const transfers: StoredTransfer[] = []
  let pageKey: string | undefined
  let calls = 0
  for (;;) {
    if (calls >= req.maxPages) return { ...base, transfers, calls, stopReason: 'page_cap' }
    const left = req.deadlineMs - now()
    if (left < 1500) return { ...base, transfers, calls, stopReason: 'deadline' }
    const params: Record<string, unknown> = {
      fromBlock: hex(req.fromBlock), toBlock: hex(req.toBlock), category: STREAM_CATEGORIES[req.stream],
      withMetadata: true, excludeZeroValue: false, maxCount: hex(STORED_HISTORY_PAGE_SIZE), order,
      [req.stream === 'from' ? 'fromAddress' : 'toAddress']: req.wallet,
      ...(pageKey ? { pageKey } : {}),
    }
    calls += 1
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(req.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
        signal: AbortSignal.timeout(Math.min(15_000, left)),
      })
    } catch (err) {
      return { ...base, transfers, calls, stopReason: 'error', error: err instanceof Error ? err.message : 'request_failed' }
    }
    if (res.status === 429) return { ...base, transfers, calls, stopReason: 'rate_limited', error: 'http_429' }
    let body: Record<string, unknown> | null = null
    try { body = await res.json() as Record<string, unknown> } catch { body = null }
    const rpcError = body?.error as { message?: unknown } | undefined
    if (!res.ok || !body || rpcError) {
      const message = typeof rpcError?.message === 'string' ? rpcError.message : `http_${res.status}`
      // A category the chain does not support is a property of the chain, not a failed read.
      if (req.stream === 'toInternal' && /internal|category/i.test(message) && calls === 1) {
        return { ...base, unsupported: true, calls, stopReason: 'unsupported', error: message }
      }
      return { ...base, transfers, calls, stopReason: 'error', error: message }
    }
    const result = body.result as Record<string, unknown> | undefined
    const rows = Array.isArray(result?.transfers) ? result!.transfers as Record<string, unknown>[] : null
    if (!rows) return { ...base, transfers, calls, stopReason: 'error', error: 'invalid_transfers_shape' }
    // A row that cannot be normalised would leave a hole inside the claimed range: drop the WHOLE page
    // and stop, so only the earlier, fully-normalised pages are claimed.
    const page: StoredTransfer[] = []
    for (const row of rows) {
      const t = toStoredTransfer(row, req.stream)
      if (!t) return { ...base, transfers, calls, stopReason: 'error', error: 'malformed_row' }
      page.push(t)
    }
    transfers.push(...page)
    const next = typeof result?.pageKey === 'string' && result.pageKey.length > 0 ? result.pageKey : undefined
    if (!next) return { ...base, transfers, calls, exhausted: true, stopReason: 'exhausted' }
    pageKey = next
  }
}

/** Current head block via eth_blockNumber; null on any failure. */
export async function fetchHeadBlock(url: string, fetchImpl?: FetchLike): Promise<number | null> {
  const doFetch = fetchImpl ?? defaultFetch
  try {
    const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const body = await res.json() as { result?: unknown }
    return parseBlock(body?.result)
  } catch {
    return null
  }
}
