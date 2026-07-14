// MODULE — distributorRecovery
//
// SCOPE, HONESTLY DISCLOSED UP FRONT: this module is READ-ONLY OBSERVABILITY, not event
// reconstruction that changes what fifoEngine matches or what priceLotsForWallet prices. Here's
// why, worked through from this codebase's real structure:
//
//   1. priceLotsForWallet.ts's own merged event list feeds ONLY per-txHash/per-token PRICING
//      lookups (priceUsdLookup/currentPriceUsdLookup — plain keyed dictionaries). Those lookups are
//      NOT order-sensitive: a given (txHash, contract) resolves to the same price regardless of
//      array order. Reordering or "enriching" its input therefore cannot change a single price it
//      resolves — there is nothing to stabilize there that isn't already stable.
//   2. fifoEngine's real FIFO lot-matching (src/modules/fifoEngine, explicitly protected/untouched)
//      IS order-sensitive — reordering or injecting synthetic events into ITS input would change
//      which lot matches which, which is exactly "changing realized/unrealized PnL formulas" in
//      effect even without editing fifoEngine's own source. This task's hard constraints forbid
//      that, so this module never touches fifoEngine's inputs.
//   3. The actual root cause of this wallet's `realizedPnlUsd: null` / `evidenceMissingCount: 198`
//      (essentially every closed lot) is a real PRICING COVERAGE gap, not a missing-event gap: the
//      same debug trace already logs deadTokenSkippedCount/unindexedTokenSkippedCount/
//      zeroLiquiditySkippedCount for this wallet — tokens with no real, discoverable market
//      anywhere. There is no real price to "reconstruct" for a token nothing prices — inventing one
//      would be exactly the fabrication this task (and this whole codebase) refuses everywhere.
//
// So instead of fabricating evidence or risking fifoEngine's real matching output, this module does
// what the task's own spec explicitly allows as the fallback: "if evidence is still missing, expose
// that clearly via observability instead of silently changing matches." It classifies each
// outbound-to-known-router event (the real router-mediated swap signal already computed elsewhere
// in this pipeline) as evidence-complete (a same-tx inbound leg IS visible in this wallet's own
// history — the swap's return leg genuinely landed here) or evidence-missing (no same-tx inbound
// leg — multi-hop, cross-wallet, or a genuinely unpriceable destination token), then reports real,
// honest counts. Nothing here is written back into normalizedEvents, recoveredEvents,
// priceLotsForWallet's input, or fifoEngine's input — this is purely additive, purely diagnostic.

import type { NormalizedEvent } from '../normalization/types'

export type RouterFlowEvidence = 'complete' | 'missing'

export type RouterFlowGroup = {
  chain: string
  token: string
  outboundEvent: NormalizedEvent
  // The same-tx inbound leg that makes this outbound a verifiable swap, when one exists — never
  // fabricated; either a real NormalizedEvent from this same wallet's own history, or null.
  matchedInboundEvent: NormalizedEvent | null
  evidence: RouterFlowEvidence
}

export type DistributorRecoveryResult = {
  applied: boolean
  totalOutboundToKnownRouter: number
  groups: RouterFlowGroup[]
  missingEvidenceCount: number
  // Honest signal for "this wallet's PnL should reproduce identically across repeated scans WHEN
  // provider data itself is consistent" — true only when EVERY router-mediated outbound this scan
  // saw has real, verifiable same-tx swap evidence. False does not mean PnL is wrong; it means at
  // least one router-mediated flow has no same-tx counterpart to verify against, so a provider-side
  // change (a re-indexed event, a late-arriving log) could plausibly shift matching next scan —
  // this module can only report that risk, never eliminate it by inventing data.
  stablePnlCandidate: boolean
}

// PURE. For a single outbound-to-router event, finds a same-transaction inbound event on a
// DIFFERENT token (the real signature of "this wallet swapped token A for token B via a router in
// one transaction") from the SAME wallet's own normalizedEvents. Never crosses transactions, never
// guesses a match by amount/timing heuristics — a same-txHash inbound leg is the only signal
// unambiguous enough not to risk a false pairing.
function findSameTxInboundLeg(outbound: NormalizedEvent, allEvents: readonly NormalizedEvent[]): NormalizedEvent | null {
  return allEvents.find((e) =>
    e.direction === 'inbound' &&
    e.txHash === outbound.txHash &&
    e.chain === outbound.chain &&
    e.contract.toLowerCase() !== outbound.contract.toLowerCase(),
  ) ?? null
}

// PURE, exported for direct testing. `normalizedEvents` should be the same array this scan's real
// pipeline already produced (normalizeEvents()'s output) — never mutated, never reordered here.
// `knownDexRouterAddresses` is caller-injected (the pipeline's own KNOWN_DEX_ROUTER_ADDRESSES),
// same "no re-derivation of an existing registry" convention already used by routerDiscovery.ts.
export function analyzeDistributorRouterFlows(
  normalizedEvents: readonly NormalizedEvent[],
  knownDexRouterAddresses: ReadonlySet<string>,
  routerDistributorMode: boolean,
): DistributorRecoveryResult {
  const outboundToKnownRouter = normalizedEvents.filter(
    (e) => e.direction === 'outbound' && knownDexRouterAddresses.has(e.toAddress.toLowerCase()),
  )

  if (!routerDistributorMode) {
    return { applied: false, totalOutboundToKnownRouter: outboundToKnownRouter.length, groups: [], missingEvidenceCount: 0, stablePnlCandidate: false }
  }

  const groups: RouterFlowGroup[] = outboundToKnownRouter.map((outboundEvent) => {
    const matchedInboundEvent = findSameTxInboundLeg(outboundEvent, normalizedEvents)
    return {
      chain: outboundEvent.chain,
      token: outboundEvent.contract,
      outboundEvent,
      matchedInboundEvent,
      evidence: matchedInboundEvent ? 'complete' : 'missing',
    }
  })

  const missingEvidenceCount = groups.filter((g) => g.evidence === 'missing').length

  return {
    applied: true,
    totalOutboundToKnownRouter: outboundToKnownRouter.length,
    groups,
    missingEvidenceCount,
    stablePnlCandidate: outboundToKnownRouter.length > 0 && missingEvidenceCount === 0,
  }
}
