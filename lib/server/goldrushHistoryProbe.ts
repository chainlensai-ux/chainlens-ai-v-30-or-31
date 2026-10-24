// lib/server/goldrushHistoryProbe.ts — measures what GoldRush (Covalent) can return for one wallet's
// history, to decide whether it can replace the per-scan transfer reconstruction + pricing:
//   1. transactions_summary — total tx count and first/last tx (sizes the problem)
//   2. transactions_v3 paging (newest → oldest via links.prev) — page latency, rows per page, how far
//      back N pages reach, and whether rows carry USD values and decoded swap logs
//   3. transfers_v2 for the wallet's most active token — whether each transfer carries a USD price at
//      the time of the transfer (quote_rate / delta_quote)
// Bounded: at most maxPages + 3 provider calls and a wall-clock budget. Returns summary numbers and
// field-presence only — never the API key or raw provider bodies.

export type ProbeFetch = (url: string) => Promise<{ status: number | null; json: unknown; ms: number }>

export type GoldrushHistoryProbeInput = { wallet: string; chain: string; maxPages: number; budgetMs: number; now?: number }

type Rec = Record<string, unknown>
const DAY = 24 * 60 * 60 * 1000
const HOST = 'https://api.covalenthq.com'

function rec(v: unknown): Rec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null
}

function items(json: unknown): unknown[] {
  const data = rec(rec(json)?.data)
  return Array.isArray(data?.items) ? data!.items as unknown[] : []
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function parseGoldrushProbeInput(params: URLSearchParams): GoldrushHistoryProbeInput | { error: string } {
  const wallet = (params.get('wallet') ?? '').trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return { error: 'wallet must be a 0x address' }
  const chain = (params.get('chain') ?? 'base-mainnet').trim()
  if (!/^[a-z0-9-]{3,40}$/.test(chain)) return { error: 'invalid chain slug' }
  const maxPages = Math.min(40, Math.max(1, Number.parseInt(params.get('maxPages') ?? '20', 10) || 20))
  return { wallet, chain, maxPages, budgetMs: 50_000 }
}

export async function runGoldrushHistoryProbe(input: GoldrushHistoryProbeInput, fetchJson: ProbeFetch) {
  const now = input.now ?? Date.now()
  const startedAt = Date.now()
  const base = `${HOST}/v1/${input.chain}/address/${input.wallet}`

  // 1. Summary
  const summaryRes = await fetchJson(`${base}/transactions_summary/`)
  const summaryItem = rec(items(summaryRes.json)[0])
  const summary = {
    httpStatus: summaryRes.status, ms: summaryRes.ms,
    totalCount: num(summaryItem?.total_count),
    earliestTx: rec(summaryItem?.earliest_transaction)?.block_signed_at ?? null,
    latestTx: rec(summaryItem?.latest_transaction)?.block_signed_at ?? null,
    fieldsPresent: summaryItem ? Object.keys(summaryItem).slice(0, 20) : [],
  }

  // 2. transactions_v3 pages, newest first
  const pages: Array<{ httpStatus: number | null; ms: number; rows: number; oldest: string | null; newest: string | null }> = []
  const rowStats = { rows: 0, withValueQuote: 0, withLogEvents: 0, logEvents: 0, decodedLogs: 0, swapLogs: 0, transferLogs: 0 }
  const swapSamples: Array<{ txHash: string | null; dex: string | null; params: string[] }> = []
  const tokenTransferCounts = new Map<string, number>()
  const firstRowFields = new Set<string>()
  let url: string | null = `${base}/transactions_v3/?page-size=100&no-spam=true&with-logs=true`
  let oldestMs: number | null = null
  let stopReason = 'max_pages'
  while (url && pages.length < input.maxPages) {
    if (Date.now() - startedAt > input.budgetMs) { stopReason = 'time_budget'; break }
    const res = await fetchJson(url)
    const rows = items(res.json)
    const stamps = rows.map((r) => rec(r)?.block_signed_at).filter((t): t is string => typeof t === 'string' && Number.isFinite(Date.parse(t)))
    const pageOldest = stamps.length ? stamps.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b)) : null
    pages.push({ httpStatus: res.status, ms: res.ms, rows: rows.length, oldest: pageOldest, newest: stamps.length ? stamps.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null })
    if (res.status !== 200) { stopReason = `http_${res.status}`; break }
    for (const raw of rows) {
      const row = rec(raw)
      if (!row) continue
      if (firstRowFields.size === 0) Object.keys(row).forEach((k) => firstRowFields.add(k))
      rowStats.rows += 1
      if (num(row.value_quote) !== null) rowStats.withValueQuote += 1
      const logs = Array.isArray(row.log_events) ? row.log_events as unknown[] : []
      if (logs.length > 0) rowStats.withLogEvents += 1
      for (const l of logs) {
        const log = rec(l)
        rowStats.logEvents += 1
        const decoded = rec(log?.decoded)
        if (!decoded) continue
        rowStats.decodedLogs += 1
        const name = typeof decoded.name === 'string' ? decoded.name : ''
        if (name === 'Swap') {
          rowStats.swapLogs += 1
          if (swapSamples.length < 3) {
            const params = Array.isArray(decoded.params) ? (decoded.params as unknown[]).map((p) => String(rec(p)?.name ?? '?')) : []
            swapSamples.push({ txHash: typeof row.tx_hash === 'string' ? row.tx_hash : null, dex: typeof log?.sender_name === 'string' ? log.sender_name : null, params })
          }
        }
        if (name === 'Transfer') {
          rowStats.transferLogs += 1
          const contract = typeof log?.sender_address === 'string' ? log.sender_address.toLowerCase() : null
          if (contract) tokenTransferCounts.set(contract, (tokenTransferCounts.get(contract) ?? 0) + 1)
        }
      }
    }
    if (pageOldest) oldestMs = Math.min(oldestMs ?? Infinity, Date.parse(pageOldest))
    if (oldestMs !== null && oldestMs < now - 90 * DAY) { stopReason = 'reached_90_days'; break }
    const links = rec(rec(rec(res.json)?.data)?.links)
    const prev = typeof links?.prev === 'string' && links.prev ? links.prev : null
    if (!prev) { stopReason = 'no_older_page'; url = null; break }
    url = prev.startsWith('http') ? prev : `${HOST}${prev.startsWith('/') ? '' : '/'}${prev}`
  }
  const coveredDays = oldestMs !== null ? (now - oldestMs) / DAY : null
  const avgPageMs = pages.length ? Math.round(pages.reduce((s, p) => s + p.ms, 0) / pages.length) : null
  const pagesFor90Days = coveredDays && coveredDays > 0 && stopReason !== 'reached_90_days' && stopReason !== 'no_older_page'
    ? Math.ceil(pages.length * (90 / coveredDays))
    : pages.length

  // 3. transfers_v2 for the most active token
  const topToken = [...tokenTransferCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  let transfersV2: Rec | null = null
  if (topToken && Date.now() - startedAt < input.budgetMs) {
    const res = await fetchJson(`${base}/transfers_v2/?contract-address=${topToken}&page-size=100`)
    const blocks = items(res.json)
    let transfers = 0, withQuoteRate = 0, withDeltaQuote = 0
    let oldest: string | null = null
    const fields = new Set<string>()
    for (const b of blocks) {
      const block = rec(b)
      const ts = typeof block?.block_signed_at === 'string' ? block.block_signed_at : null
      if (ts && (!oldest || Date.parse(ts) < Date.parse(oldest))) oldest = ts
      for (const t of Array.isArray(block?.transfers) ? block!.transfers as unknown[] : []) {
        const tr = rec(t)
        if (!tr) continue
        if (fields.size === 0) Object.keys(tr).forEach((k) => fields.add(k))
        transfers += 1
        if (num(tr.quote_rate) !== null) withQuoteRate += 1
        if (num(tr.delta_quote) !== null) withDeltaQuote += 1
      }
    }
    transfersV2 = { token: topToken, httpStatus: res.status, ms: res.ms, rows: blocks.length, transfers, withQuoteRate, withDeltaQuote, oldest, transferFields: [...fields].slice(0, 30) }
  }

  return {
    wallet: input.wallet, chain: input.chain, elapsedMs: Date.now() - startedAt,
    summary,
    transactionsV3: {
      pagesFetched: pages.length, stopReason, avgPageMs, coveredDays: coveredDays === null ? null : Math.round(coveredDays * 10) / 10,
      estimatedPagesFor90Days: pagesFor90Days,
      estimatedSecondsFor90DaysSequential: avgPageMs === null ? null : Math.round((pagesFor90Days * avgPageMs) / 1000),
      rowStats, swapSamples, rowFields: [...firstRowFields].slice(0, 40), pages: pages.slice(0, 40),
    },
    transfersV2,
  }
}
