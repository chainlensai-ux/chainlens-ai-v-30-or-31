// BATCHED GOLDRUSH HISTORICAL PRICES. The primary source used to ask GoldRush for ONE token on ONE
// day per call (getTokenPrices with from === to). The same endpoint takes several comma-separated
// contracts and a date range and returns every day in it — verified live: 3 tokens × 30 days in one
// 0.9s call; 50 tokens in one call; batch prices identical to single-token prices on 10/10 tokens.
//
// Lookups that ACTUALLY reach GoldRush (after the scan's KV cache and, on Base, after GeckoTerminal /
// DexScreener) and arrive within BATCH_WINDOW_MS of each other are sent as one call per group of up to
// MAX_TOKENS_PER_CALL tokens and per cluster of their requested days. Days are never invented: a call
// covers the requested days (clustered: span ≤ MAX_SPAN_DAYS) and may only be
// WIDENED, inside that span cap, to other days this scan already needs for those tokens (hints) — it
// never adds a call. So batching can only ever make the same number of calls as before or fewer.
//
// One unknown contract fails the whole call with HTTP 400 naming it (verified live); it is removed,
// answered as "no price" and the rest retried (up to MAX_UNKNOWN_CONTRACT_DROPS unknowns per batch). Any other failure (429 / 5xx / timeout / network)
// returns 'error' so the caller falls back to today's one-token call. Kill switch:
// GOLDRUSH_BATCH_PRICING=0.

import { logRpcCall } from '@/lib/server/rpcDebug'

export const BATCH_WINDOW_MS = 25
export const MAX_TOKENS_PER_CALL = 20
// Clustering is by span only: GoldRush counts a pricing call, not its days (wallet-provider-cost-audit
// estimates 1 credit per call), so merging nearby days into one call is cheaper, never dearer.
export const MAX_GAP_DAYS = 30
export const MAX_SPAN_DAYS = 30
export const BATCH_CALL_TIMEOUT_MS = 8_000
// A spam-heavy wallet's batch often holds several contracts GoldRush has never seen; each 400 names one.
// Dropping only the first sent the whole batch to per-(token, day) single calls on the second. Each retry
// removes at least one token that would otherwise cost its own single call, so this never adds calls;
// the cap bounds the sequential retries' latency.
export const MAX_UNKNOWN_CONTRACT_DROPS = 5
const DAY_MS = 86_400_000

export type BatchAnswer =
  | { status: 'price'; price: number }
  | { status: 'no_price'; tokenHasAnyPrice: boolean }
  | { status: 'error' }
  /** The scan's GoldRush budget refused the call — answered like today's refused call (null, not cached). */
  | { status: 'refused' }

export function isGoldrushBatchPricingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GOLDRUSH_BATCH_PRICING !== '0'
}

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`)
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Requested days → ranges: a new range starts after a gap > maxGap days or when span would exceed maxSpan. */
export function clusterDays(days: readonly string[], maxGapDays = MAX_GAP_DAYS, maxSpanDays = MAX_SPAN_DAYS): Array<{ from: string; to: string }> {
  const sorted = [...new Set(days)].filter(d => Number.isFinite(dayMs(d))).sort()
  const out: Array<{ from: string; to: string }> = []
  for (const d of sorted) {
    const last = out[out.length - 1]
    if (last && dayMs(d) - dayMs(last.to) <= maxGapDays * DAY_MS && dayMs(d) - dayMs(last.from) <= maxSpanDays * DAY_MS) last.to = d
    else out.push({ from: d, to: d })
  }
  return out
}

/** Widens a range toward hinted days, never past maxSpan days. Never creates a range. */
export function widenWithHints(range: { from: string; to: string }, hints: readonly string[], maxSpanDays = MAX_SPAN_DAYS): { from: string; to: string } {
  let from = dayMs(range.from)
  let to = dayMs(range.to)
  const near = [...new Set(hints)].map(dayMs).filter(Number.isFinite)
    .sort((a, b) => Math.min(Math.abs(a - from), Math.abs(a - to)) - Math.min(Math.abs(b - from), Math.abs(b - to)))
  for (const h of near) {
    const nf = Math.min(from, h)
    const nt = Math.max(to, h)
    if (nt - nf <= maxSpanDays * DAY_MS) { from = nf; to = nt }
  }
  return { from: dayStr(from), to: dayStr(to) }
}

/** The contract a "not found" 400 names, if any. */
export function missingContractFromError(message: unknown): string | null {
  const m = typeof message === 'string' ? message.match(/contract address '?(0x[0-9a-fA-F]{40})'? not found/i) : null
  return m ? m[1].toLowerCase() : null
}

type Pending = { token: string; date: string; resolve: (a: BatchAnswer) => void }
type Group = { chainSlug: string; chain: string; items: Pending[]; timer: ReturnType<typeof setTimeout> | null }

export type GoldrushBatcherDeps = {
  apiKey: string
  fetchImpl?: typeof fetch
  /** Paces every real call (the shared GoldRush gate). */
  wait?: () => Promise<void>
  /** Scan budget for one real call; false = refused, every lookup in it answers "no price" (fails closed). */
  consume?: (chain: string) => boolean
  /** Other days this scan needs for a token (lowercase) on a chain. */
  hintsFor?: (chain: string, token: string) => readonly string[]
  /** Every finite price a call returned, so later lookups are free. */
  onPrices?: (chain: string, token: string, prices: ReadonlyMap<string, number>) => void
  /** One real call finished: whether any requested lookup got a price, and its duration. */
  onCall?: (info: { chain: string; tokens: number; from: string; to: string; ok: boolean; used: boolean; ms: number }) => void
  windowMs?: number
  maxTokens?: number
}

export function createGoldrushPriceBatcher(deps: GoldrushBatcherDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const groups = new Map<string, Group>()
  const maxTokens = deps.maxTokens ?? MAX_TOKENS_PER_CALL

  async function callOnce(chainSlug: string, chain: string, tokens: string[], from: string, to: string): Promise<{ ok: true; data: Map<string, Map<string, number>>; ms: number } | { ok: false; missing: string | null }> {
    await deps.wait?.()
    const started = Date.now()
    logRpcCall({ route: 'pricingAtTimeEngine:goldrushBatch', chain, method: 'goldrush_historical_by_addresses_v2:batch', feature: 'wallet_scan_historical_pricing' })
    try {
      const res = await fetchImpl(`https://api.covalenthq.com/v1/pricing/historical_by_addresses_v2/${chainSlug}/USD/${tokens.join(',')}/?from=${from}&to=${to}`, {
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(BATCH_CALL_TIMEOUT_MS),
      })
      const json = await res.json().catch(() => null) as { error?: boolean; error_message?: string; data?: Array<{ contract_address?: string; prices?: Array<{ date?: string; price?: number | null }> }> } | null
      if (!res.ok || !json || json.error) {
        deps.onCall?.({ chain, tokens: tokens.length, from, to, ok: false, used: false, ms: Date.now() - started })
        return { ok: false, missing: res.status === 400 ? missingContractFromError(json?.error_message) : null }
      }
      const data = new Map<string, Map<string, number>>()
      for (const row of Array.isArray(json.data) ? json.data : []) {
        const addr = row.contract_address?.toLowerCase()
        if (!addr) continue
        const days = new Map<string, number>()
        for (const p of row.prices ?? []) if (typeof p.date === 'string' && typeof p.price === 'number' && Number.isFinite(p.price)) days.set(p.date, p.price)
        data.set(addr, days)
      }
      return { ok: true, data, ms: Date.now() - started }
    } catch {
      deps.onCall?.({ chain, tokens: tokens.length, from, to, ok: false, used: false, ms: Date.now() - started })
      return { ok: false, missing: null }
    }
  }

  async function runCall(chainSlug: string, chain: string, items: Pending[], range: { from: string; to: string }): Promise<void> {
    let tokens = [...new Set(items.map(i => i.token))]
    for (let attempt = 0; attempt <= MAX_UNKNOWN_CONTRACT_DROPS && tokens.length > 0; attempt += 1) {
      if (deps.consume && !deps.consume(chain)) {
        for (const i of items) if (tokens.includes(i.token)) i.resolve({ status: 'refused' })
        return
      }
      const result = await callOnce(chainSlug, chain, tokens, range.from, range.to)
      if (result.ok) {
        let used = false
        for (const token of tokens) {
          const days = result.data.get(token) ?? new Map<string, number>()
          if (days.size > 0) deps.onPrices?.(chain, token, days)
          for (const i of items) {
            if (i.token !== token) continue
            const price = days.get(i.date)
            if (price != null) { used = true; i.resolve({ status: 'price', price }) }
            else i.resolve({ status: 'no_price', tokenHasAnyPrice: days.size > 0 })
          }
        }
        deps.onCall?.({ chain, tokens: tokens.length, from: range.from, to: range.to, ok: true, used, ms: result.ms })
        return
      }
      // A named unknown contract: answer it "no price" and retry the rest (up to MAX_UNKNOWN_CONTRACT_DROPS).
      if (result.missing && tokens.includes(result.missing) && attempt < MAX_UNKNOWN_CONTRACT_DROPS) {
        for (const i of items) if (i.token === result.missing) i.resolve({ status: 'no_price', tokenHasAnyPrice: false })
        tokens = tokens.filter(t => t !== result.missing)
        continue
      }
      for (const i of items) if (tokens.includes(i.token)) i.resolve({ status: 'error' })
      return
    }
  }

  async function flush(key: string): Promise<void> {
    const group = groups.get(key)
    if (!group) return
    groups.delete(key)
    const byToken = new Map<string, Pending[]>()
    for (const item of group.items) byToken.set(item.token, [...(byToken.get(item.token) ?? []), item])
    const tokenList = [...byToken.keys()]
    const work: Array<Promise<void>> = []
    for (let i = 0; i < tokenList.length; i += maxTokens) {
      const chunk = tokenList.slice(i, i + maxTokens)
      const chunkItems = chunk.flatMap(t => byToken.get(t)!)
      const hints = chunk.flatMap(t => deps.hintsFor?.(group.chain, t) ?? [])
      for (const cluster of clusterDays(chunkItems.map(it => it.date))) {
        const range = widenWithHints(cluster, hints)
        const inRange = chunkItems.filter(it => it.date >= cluster.from && it.date <= cluster.to)
        work.push(runCall(group.chainSlug, group.chain, inRange, range))
      }
    }
    await Promise.all(work)
  }

  return {
    request(chainSlug: string, chain: string, token: string, date: string): Promise<BatchAnswer> {
      return new Promise<BatchAnswer>((resolve) => {
        const key = chainSlug
        let group = groups.get(key)
        if (!group) {
          group = { chainSlug, chain, items: [], timer: null }
          groups.set(key, group)
          group.timer = setTimeout(() => { void flush(key) }, deps.windowMs ?? BATCH_WINDOW_MS)
        }
        group.items.push({ token: token.toLowerCase(), date, resolve })
      })
    },
  }
}
