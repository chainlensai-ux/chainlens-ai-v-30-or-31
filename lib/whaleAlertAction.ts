// How a feed row's on-chain action is described. Rows are wallet token transfers: `side` is only
// the direction relative to the tracked wallet (buy = tokens in, sell = tokens out). That alone is
// not evidence of a trade, so a single-direction row is "received"/"sent". "Swapped" requires both
// directions inside the same transaction (a grouped row whose legs disagree on side → side null).

export type WhaleActionKind = 'swap' | 'in' | 'out' | 'transfer'

export type WhaleAction = {
  kind: WhaleActionKind
  /** Past-tense verb for the row sentence. */
  verb: 'swapped' | 'received' | 'sent' | 'moved'
  /** Short chip label. */
  chip: 'SWAP' | 'IN' | 'OUT' | 'MOVE'
}

export function describeWhaleAction(row: { side?: string | null; token_symbol?: string | null; legs?: number | null }): WhaleAction {
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
