// MODULE — bridgeDetection: pure helpers.

import type { NormalizedEvent } from '../normalization/types'
import type { BridgeCandidateEvent, BridgeConfidence } from './types'
import { BRIDGE_AMOUNT_TOLERANCE_PCT, BRIDGE_MATCH_WINDOW_MS } from './types'

export function amountsWithinTolerance(a: number, b: number, tolerancePct: number): boolean {
  if (a <= 0 || b <= 0) return false
  const diff = Math.abs(a - b)
  const larger = Math.max(a, b)
  return diff / larger <= tolerancePct
}

export function confidenceFor(outbound: NormalizedEvent, inbound: NormalizedEvent, deltaMs: number): { confidence: BridgeConfidence; basis: string } {
  const exactAmount = outbound.amount === inbound.amount
  const withinTightWindow = deltaMs <= 10 * 60 * 1000
  const minutesApart = Math.round(deltaMs / 60000)

  if (exactAmount && withinTightWindow) {
    return { confidence: 'high', basis: `Same symbol, identical amount, ${minutesApart}m apart` }
  }
  if (withinTightWindow) {
    return { confidence: 'medium', basis: `Same symbol, amount within ${(BRIDGE_AMOUNT_TOLERANCE_PCT * 100).toFixed(1)}%, ${minutesApart}m apart` }
  }
  return { confidence: 'low', basis: `Same symbol, amount within ${(BRIDGE_AMOUNT_TOLERANCE_PCT * 100).toFixed(1)}%, ${minutesApart}m apart (wider time gap)` }
}

// PURE. Detects bridge candidates: an outbound (wallet -> elsewhere) leg on one chain paired with
// an inbound (elsewhere -> wallet) leg of the same symbol on a DIFFERENT chain, within the match
// window and amount tolerance. Each raw event is consumed by at most one match (greedy, closest-
// in-time-first) so a single transfer can never be double-counted across multiple candidate pairs.
export function detectBridgeCandidates(normalizedEvents: NormalizedEvent[]): BridgeCandidateEvent[] {
  // ORDER-DEPENDENCE FIX, DISCLOSED (wallet-scanner audit): previously iterated outboundLegs in
  // whatever order normalizedEvents happened to supply them (not chronological), and each outbound
  // leg greedily claimed its own closest-in-time unused inbound independently of the others. Because
  // "best match" was computed per-outbound-leg rather than globally, a later-in-array (but
  // later-in-time or arbitrary-order) outbound leg could claim an inbound leg that was actually the
  // correct/closer match for an earlier-in-time outbound leg, cross-matching two similar bridge
  // transactions (e.g. the same token/amount bridged twice within the match window) to the wrong
  // counterpart. Processing outbound legs in chronological order — earliest first — means the
  // earliest (and therefore most likely correct) outbound leg always gets first claim on its closest
  // inbound, matching the same "closest-in-time-first" intent the module header already documents.
  const outboundLegs = normalizedEvents
    .filter((e) => e.direction === 'outbound')
    .map((e) => ({ event: e, ts: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts)

  const inboundLegs = normalizedEvents
    .filter((e) => e.direction === 'inbound')
    .map((e) => ({ event: e, ts: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.ts))

  const usedInboundKeys = new Set<string>()
  const candidates: BridgeCandidateEvent[] = []

  for (const out of outboundLegs) {
    let best: { inbound: (typeof inboundLegs)[number]; deltaMs: number } | null = null

    for (const inb of inboundLegs) {
      const key = `${inb.event.txHash}|${inb.event.contract}|${inb.event.amount}`
      if (usedInboundKeys.has(key)) continue
      if (inb.event.chain === out.event.chain) continue // must be a different chain
      if (inb.event.symbol.toLowerCase() !== out.event.symbol.toLowerCase()) continue
      if (!amountsWithinTolerance(out.event.amount, inb.event.amount, BRIDGE_AMOUNT_TOLERANCE_PCT)) continue

      const deltaMs = inb.ts - out.ts
      if (deltaMs < 0 || deltaMs > BRIDGE_MATCH_WINDOW_MS) continue // inbound leg must follow outbound leg

      if (!best || deltaMs < best.deltaMs) best = { inbound: inb, deltaMs }
    }

    if (best) {
      const key = `${best.inbound.event.txHash}|${best.inbound.event.contract}|${best.inbound.event.amount}`
      usedInboundKeys.add(key)
      const { confidence, basis } = confidenceFor(out.event, best.inbound.event, best.deltaMs)
      candidates.push({
        type: 'bridge',
        chainFrom: out.event.chain,
        chainTo: best.inbound.event.chain,
        token: out.event.symbol,
        amount: out.event.amount,
        timestamp: out.event.timestamp,
        txHashFrom: out.event.txHash,
        txHashTo: best.inbound.event.txHash,
        confidence,
        basis,
      })
    }
  }

  return candidates.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
}
