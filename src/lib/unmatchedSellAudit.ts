// Unmatched sell audit: which tokens the FIFO sells with no earlier buy belong to.
//
// The PnL gate (fifoEngine derivePublicPnlStatus) divides verified lots by matched lots PLUS
// unmatched sells, so these sells weigh on coverage as much as unpriced lots do. For each token
// this reports how many sells went unmatched, how many were only partly unmatched, and whether any
// inbound leg for the token exists before its first unmatched sell — none means the buy is outside
// the scanned history; some means the inbound amounts were too small to cover the sells.
// Diagnostic only: nothing here changes a lot or a count.

import type { UnmatchedEventIdentity } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'

export type UnmatchedSellAudit = {
  unmatchedSells: number
  partial: number
  noInboundBeforeFirstSell: number
  byToken: { token: string; sells: number; partial: number; firstSellAt: string; firstInboundAt: string | null }[]
}

const TOP_TOKENS = 12

export function buildUnmatchedSellAudit(params: {
  unmatchedSells: readonly UnmatchedEventIdentity[]
  events: readonly NormalizedEvent[]
  excludedTxKeys?: ReadonlySet<string>
}): UnmatchedSellAudit {
  const firstInbound = new Map<string, number>()
  for (const e of params.events) {
    if (e.direction !== 'inbound') continue
    if (params.excludedTxKeys?.has(`${e.chain}:${e.txHash.toLowerCase()}`)) continue
    const ts = Date.parse(e.timestamp)
    if (!Number.isFinite(ts)) continue
    const key = `${e.chain}:${e.contract.toLowerCase()}`
    const prev = firstInbound.get(key)
    if (prev == null || ts < prev) firstInbound.set(key, ts)
  }

  const rows = new Map<string, { token: string; sells: number; partial: number; firstSell: number }>()
  let partial = 0
  for (const s of params.unmatchedSells) {
    const key = `${s.chain}:${s.token.toLowerCase()}`
    const row = rows.get(key) ?? { token: key, sells: 0, partial: 0, firstSell: s.timestamp }
    row.sells += 1
    const isPartial = s.unmatchedRaw != null && s.sellRaw != null && s.unmatchedRaw !== s.sellRaw
    if (isPartial) { row.partial += 1; partial += 1 }
    if (s.timestamp < row.firstSell) row.firstSell = s.timestamp
    rows.set(key, row)
  }

  let noInboundBeforeFirstSell = 0
  const byToken = [...rows.values()].map((row) => {
    const inbound = firstInbound.get(row.token) ?? null
    if (inbound == null || inbound > row.firstSell) noInboundBeforeFirstSell += row.sells
    return {
      token: row.token,
      sells: row.sells,
      partial: row.partial,
      firstSellAt: new Date(row.firstSell).toISOString(),
      firstInboundAt: inbound == null ? null : new Date(inbound).toISOString(),
    }
  })

  return {
    unmatchedSells: params.unmatchedSells.length,
    partial,
    noInboundBeforeFirstSell,
    byToken: byToken.sort((a, b) => b.sells - a.sells).slice(0, TOP_TOKENS),
  }
}
