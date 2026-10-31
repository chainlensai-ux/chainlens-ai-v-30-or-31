// ACTIVITY SUMMARIES for the Whale Alerts feed. Input: one priced alert per (transaction, wallet),
// already classified (BUY / SELL / EXIT / SWAP / IN / OUT) and filtered. Output: one feed item per
// meaningful activity — repeated buys of one token by one wallet become "accumulated $65K AERO across
// 3 buys", repeated sells become distribution, a verified zero-balance sell becomes an exit.
//
// Every number comes from the member transactions: the total is the sum of each trade's one-side
// value (never both legs), the count is the number of transactions, and every member keeps its tx hash
// for the expandable details. Words like "exited" are only used when the evidence exists (an EXIT
// trade is a sell whose wallet now holds 0 of the token, checked on-chain by the feed).

type Row = Record<string, unknown>

/** Same wallet + token + direction within this gap continues one activity. */
export const ACTIVITY_GAP_MS = 6 * 60 * 60_000
export const HIGH_PRIORITY_USD = 50_000
export const UNUSUAL_MULTIPLE = 5
export const UNUSUAL_MIN_USD = 10_000

export type ActivityKind = 'accumulation' | 'distribution' | 'exit' | 'buy' | 'sell' | 'swap' | 'in' | 'out'

export type ActivityMember = {
  tx_hash: string | null
  occurred_at: string | null
  amount_usd: number | null
  amount_token: number | null
  trade_kind: string | null
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const timeOf = (row: Row) => { const t = Date.parse(String(row.occurred_at ?? '')); return Number.isFinite(t) ? t : 0 }

function direction(kind: string | null): 'buy' | 'sell' | 'in' | 'out' | 'swap' | null {
  if (kind === 'buy') return 'buy'
  if (kind === 'sell' || kind === 'exit') return 'sell'
  if (kind === 'in' || kind === 'out' || kind === 'swap') return kind
  return null
}

export function fmtUsdShort(usd: number): string {
  const trim = (v: string) => v.replace(/\.0$/, '')
  if (usd >= 1_000_000) return `$${trim((usd / 1_000_000).toFixed(usd >= 10_000_000 ? 0 : 1))}M`
  if (usd >= 1_000) return `$${trim((usd / 1_000).toFixed(usd >= 100_000 ? 0 : 1))}K`
  return `$${Math.round(usd)}`
}

function tokenOf(row: Row): string {
  return str(row.trade_token_symbol) ?? str(row.focus_token_symbol) ?? str(row.token_symbol) ?? 'token'
}

function walletOf(row: Row): string {
  return str(row.wallet_label) ?? 'Tracked wallet'
}

function headlineFor(kind: ActivityKind, wallet: string, token: string, usd: number, count: number): string {
  const v = fmtUsdShort(usd)
  switch (kind) {
    case 'accumulation': return `${wallet} accumulated ${v} ${token} across ${count} buys`
    case 'distribution': return `${wallet} sold ${v} ${token} across ${count} sells`
    case 'exit': return count > 1 ? `${wallet} exited ${token} — sold ${v} across ${count} sells` : `${wallet} exited ${token} — sold ${v}`
    case 'buy': return `${wallet} bought ${v} ${token}`
    case 'sell': return `${wallet} sold ${v} ${token}`
    case 'swap': return count > 1 ? `${wallet} swapped ${v} into ${token} across ${count} swaps` : `${wallet} swapped ${v} into ${token}`
    case 'in': return count > 1 ? `${wallet} received ${v} ${token} in ${count} transfers` : `${wallet} received ${v} ${token}`
    case 'out': return count > 1 ? `${wallet} sent ${v} ${token} in ${count} transfers` : `${wallet} sent ${v} ${token}`
  }
}

function spanText(ms: number): string {
  if (ms < 60 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} min`
  return `${Math.round(ms / (60 * 60_000))}h`
}

/** Groups per-transaction alerts into activities. Rows without a direction or wallet pass through alone. */
export function groupWhaleActivity(rows: readonly Row[]): Row[] {
  const sorted = [...rows].sort((a, b) => timeOf(a) - timeOf(b))
  const open = new Map<string, Row[][]>()
  const singles: Row[][] = []
  for (const row of sorted) {
    const dir = direction(str(row.trade_kind))
    const wallet = str(row.wallet_address)?.toLowerCase()
    const token = (str(row.trade_token_address) ?? tokenOf(row)).toLowerCase()
    if (!dir || !wallet) { singles.push([row]); continue }
    const key = `${wallet}|${token}|${dir}`
    const runs = open.get(key) ?? []
    const last = runs[runs.length - 1]
    if (last && timeOf(row) - timeOf(last[last.length - 1]) <= ACTIVITY_GAP_MS) last.push(row)
    else runs.push([row])
    open.set(key, runs)
  }
  const groups = [...[...open.values()].flat(), ...singles]
  return groups.map(buildActivity)
}

function buildActivity(members: Row[]): Row {
  const newest = members[members.length - 1]
  const oldest = members[0]
  const count = members.length
  const total = Math.round(members.reduce((s, m) => s + (num(m.amount_usd) ?? 0), 0) * 100) / 100
  const kinds = new Set(members.map(m => str(m.trade_kind)))
  const dir = direction(str(newest.trade_kind))
  const kind: ActivityKind =
    kinds.has('exit') ? 'exit'
      : dir === 'buy' ? (count > 1 ? 'accumulation' : 'buy')
      : dir === 'sell' ? (count > 1 ? 'distribution' : 'sell')
      : (dir ?? 'swap')
  const token = tokenOf(newest)
  const span = timeOf(newest) - timeOf(oldest)
  const why: string[] = []
  if (kind === 'exit') why.push(`Wallet now holds 0 ${token} (checked on-chain)`)
  if (count > 1) why.push(`${count} ${kind === 'accumulation' ? 'buys' : kind === 'distribution' || kind === 'exit' ? 'sells' : 'transactions'} in ${spanText(span)}`)
  if (total >= HIGH_PRIORITY_USD) why.push('Top-size movement')
  const tokenAmounts = members.map(m => num(m.amount_token))
  const tokenTotal = count > 1 && tokenAmounts.every(a => a != null) ? tokenAmounts.reduce((s, a) => s + (a as number), 0) : num(newest.amount_token)
  const activityMembers: ActivityMember[] = members.map(m => ({
    tx_hash: str(m.tx_hash),
    occurred_at: str(m.occurred_at),
    amount_usd: num(m.amount_usd),
    amount_token: num(m.amount_token),
    trade_kind: str(m.trade_kind),
  })).reverse()
  return {
    ...newest,
    amount_usd: total,
    amount_token: tokenTotal,
    first_occurred_at: oldest.occurred_at ?? null,
    repeats: count,
    activity_kind: kind,
    activity_count: count,
    activity_headline: headlineFor(kind, walletOf(newest), token, total, count),
    activity_why: why,
    activity_members: activityMembers,
  }
}

/**
 * Feed order: high-priority activities first (exits, large accumulation / distribution, top-size or
 * unusual-for-this-wallet movements), newest first within each tier. Repetitive bot wallets never
 * take the top tier on their own repetition.
 */
export function whaleActivityPriority(row: Row): 'high' | 'normal' {
  const kind = str(row.activity_kind)
  const usd = num(row.amount_usd) ?? 0
  const bot = /\bbot\b|router|contract/i.test(walletOf(row))
  if (kind === 'exit' && usd >= 1_000) return 'high'
  if (usd >= HIGH_PRIORITY_USD) return 'high'
  if (!bot && (kind === 'accumulation' || kind === 'distribution') && usd >= 10_000) return 'high'
  if (row.activity_unusual === true) return 'high'
  return 'normal'
}

/**
 * Marks a single movement unusually large for its wallet: at least UNUSUAL_MULTIPLE × the wallet's
 * average priced alert over 7 days, and at least UNUSUAL_MIN_USD. Needs real history (≥3 alerts).
 */
export function markUnusual(row: Row, history: { alertCount7d: number; verifiedUsdFlow7d: number | null } | null): Row {
  const usd = num(row.amount_usd) ?? 0
  if (!history || history.alertCount7d < 3 || !history.verifiedUsdFlow7d || usd < UNUSUAL_MIN_USD) return row
  const average = history.verifiedUsdFlow7d / history.alertCount7d
  if (!(average > 0) || usd < UNUSUAL_MULTIPLE * average) return row
  const why = Array.isArray(row.activity_why) ? (row.activity_why as string[]) : []
  return { ...row, activity_unusual: true, activity_why: [...why, `${Math.round(usd / average)}× this wallet's 7-day average`] }
}

export function sortWhaleActivity(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const pa = whaleActivityPriority(a) === 'high' ? 1 : 0
    const pb = whaleActivityPriority(b) === 'high' ? 1 : 0
    return pb - pa || timeOf(b) - timeOf(a)
  })
}
