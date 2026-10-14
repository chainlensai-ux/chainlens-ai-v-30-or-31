// How a feed row's on-chain action is described. Rows are wallet token transfers: `side` is only
// the direction relative to the tracked wallet (buy = tokens in, sell = tokens out). That alone is
// not evidence of a trade, so a single-direction row is "received"/"sent". "Swapped" requires both
// directions inside the same transaction (a grouped row whose legs disagree on side → side null).

export type WhaleActionKind = 'buy' | 'sell' | 'exit' | 'swap' | 'in' | 'out' | 'transfer'

export type WhaleAction = {
  kind: WhaleActionKind
  /** Past-tense verb for the row sentence. */
  verb: 'bought' | 'sold' | 'exited' | 'swapped' | 'received' | 'sent' | 'moved'
  /** Short chip label. */
  chip: 'BUY' | 'SELL' | 'EXIT' | 'SWAP' | 'IN' | 'OUT' | 'MOVE'
}

type ActionRow = { side?: string | null; token_symbol?: string | null; legs?: number | null; trade_kind?: string | null }

const BY_KIND: Record<string, WhaleAction> = {
  buy: { kind: 'buy', verb: 'bought', chip: 'BUY' },
  sell: { kind: 'sell', verb: 'sold', chip: 'SELL' },
  exit: { kind: 'exit', verb: 'exited', chip: 'EXIT' },
  swap: { kind: 'swap', verb: 'swapped', chip: 'SWAP' },
  in: { kind: 'in', verb: 'received', chip: 'IN' },
  out: { kind: 'out', verb: 'sent', chip: 'OUT' },
}

/**
 * The feed classifies each tx from its legs (lib/server/whaleTradeClassify.ts): BUY/SELL only when
 * base assets were paid/received for a token in the same tx, EXIT only when the wallet's balance
 * of the sold token is now 0. Rows without that classification fall back to direction wording.
 */
export function describeWhaleAction(row: ActionRow): WhaleAction {
  const known = row.trade_kind ? BY_KIND[row.trade_kind] : undefined
  if (known) return known
  const side = (row.side ?? '').toLowerCase()
  const multiToken = (row.token_symbol ?? '').includes(' / ')
  const legs = typeof row.legs === 'number' ? row.legs : 1
  const mixedSides = (multiToken || legs >= 2) && side !== 'buy' && side !== 'sell'
  if (mixedSides) return { kind: 'swap', verb: 'swapped', chip: 'SWAP' }
  if (side === 'buy') return { kind: 'in', verb: 'received', chip: 'IN' }
  if (side === 'sell') return { kind: 'out', verb: 'sent', chip: 'OUT' }
  return { kind: 'transfer', verb: 'moved', chip: 'MOVE' }
}

/**
 * Discards stale responses: each request takes a ticket, and only the latest ticket may write
 * state. Prevents a slow response for an old filter from overwriting a newer one.
 */
export function createLatestRequestGate() {
  let latest = 0
  return {
    next(): number { latest += 1; return latest },
    isLatest(ticket: number): boolean { return ticket === latest },
  }
}

/** Filter options the feed API understands (type = trade kind, side = exposure direction). */
export const TRADE_TYPE_OPTIONS = ['all', 'buy', 'sell', 'exit', 'swap', 'in', 'out'] as const
export const TRADE_SIDE_OPTIONS = ['all', 'buy', 'sell'] as const
export const SEVERITY_OPTIONS = ['all', 'major', 'large', 'medium', 'small'] as const
export const FILTER_OPTION_LABELS: Record<string, string> = {
  buy: 'Buy', sell: 'Sell', exit: 'Exit (sold out)', swap: 'Swap', in: 'In (received)', out: 'Out (sent)',
  major: 'Major ($25K+)', large: 'Large ($10K+)', medium: 'Medium ($5K+)', small: 'Small ($1K+)',
}

type ReasonRow = ActionRow & {
  repeats?: number | null
  token_risk_label?: string | null
  trade_token_symbol?: string | null
  focus_token_symbol?: string | null
}

/**
 * One-line description built only from facts on the row — never empty, never inferred intent.
 */
export function whaleRowReason(row: ReasonRow): string {
  if (row.token_risk_label) return row.token_risk_label
  const action = describeWhaleAction(row)
  const token = row.trade_token_symbol ?? row.focus_token_symbol ?? row.token_symbol ?? 'token'
  const lead =
    action.kind === 'exit' ? `Sold ${token} — wallet now holds none`
    : action.kind === 'buy' ? `Bought ${token}`
    : action.kind === 'sell' ? `Sold ${token}`
    : action.kind === 'swap' ? `Swapped ${row.token_symbol ?? 'tokens'}`
    : action.kind === 'in' ? `Received ${token}`
    : action.kind === 'out' ? `Sent ${token}`
    : `Moved ${token}`
  // The USD value (or "USD unavailable") is already the row's headline amount — not repeated here.
  const repeats = (row.repeats ?? 1) > 1 ? `${row.repeats}× within 5 min` : null
  return [lead, repeats].filter(Boolean).join(' · ')
}
