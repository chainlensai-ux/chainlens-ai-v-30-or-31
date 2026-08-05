// MODULE — eventClassification
//
// GOAL, DISCLOSED (evidence-first PnL completion task, requirements #1-#6): fifoEngine
// (src/modules/fifoEngine) treats EVERY inbound normalized event as a "buy" and every outbound
// event as a "sell", regardless of whether it was actually a trade — an airdrop, a bridge deposit,
// an LP withdrawal, a router pass-through hop, or plain dust all enter FIFO exactly like a real
// swap leg does today. This module is a PURE, deterministic, offline classifier that runs BEFORE
// FIFO: it groups a wallet's normalized events by (chain, txHash) — transaction-first, per
// requirement #2 — nets each token's flow within that transaction, and classifies every event into
// exactly one of eight categories. Only `genuine_trade_leg` (and `unknown`, kept conservatively
// eligible — see below) are meant to reach FIFO; every other category is real, positive evidence
// that an event is NOT a trade.
//
// CONSERVATISM, DISCLOSED: this classifier only ever moves an event OUT of trade-eligibility when
// it has a real, structural, positive signal for doing so — a genuine same-token duplicate/refund/
// intermediary-hop pattern WITHIN one transaction (never a lone single-leg event, which stays
// trade-eligible exactly as fifoEngine has always treated it — see the "NON-REGRESSION SCOPING"
// disclosure below for why), a negligible on-chain amount, or a repeated-identical-amount
// inbound-only pattern with no outbound counterpart ever. It never guesses a router/bridge/
// LP-staking address — `bridge` and
// `lp_staking` are declared in the type for completeness (per requirement #1's full category list)
// but this pass never actually assigns them: this codebase has no verified bridge/LP-staking
// contract registry to check against (unlike KNOWN_DEX_ROUTER_ADDRESSES, an existing, already-used
// registry), and guessing one would violate this task's own "no guessed router/pool acceptance"
// hard limit. `unknown` is likewise never assigned by this pass — every event is resolved into one
// of the other six categories — but the type keeps it for forward compatibility with a future
// signal this codebase doesn't have yet, and callers should treat it exactly like
// `genuine_trade_leg` (FIFO-eligible) rather than silently excluding a leg this classifier couldn't
// positively rule out as a trade.
//
// NO NEW PROVIDER CALLS, DISCLOSED: this operates entirely on already-fetched, already-normalized
// events (NormalizedEvent — module 2's output). It makes zero network/provider calls of its own.

import type { NormalizedEvent } from '../normalization/types'
import type { UnmatchedEventIdentity } from '../fifoEngine/types'

export type EventClassification =
  | 'genuine_trade_leg'
  | 'ordinary_transfer'
  | 'distribution_airdrop'
  | 'router_intermediary'
  | 'bridge'
  | 'lp_staking'
  | 'dust_non_economic'
  | 'unknown'

export type ClassifiedEvent = { event: NormalizedEvent; classification: EventClassification }

export type EventClassificationContext = {
  // Same registry already used by routerInference/distributorRecovery elsewhere in this pipeline —
  // never re-derived or guessed here, just reused as an injected read-only signal.
  knownDexRouterAddresses: ReadonlySet<string>
}

// Deterministic, disclosed threshold (human-decimal token units) below which an amount is treated
// as on-chain noise (wei-level dust, rounding remainders) rather than a real economic transfer — far
// below any real "small" transfer (e.g. 0.67 tokens, this task's own ordinary-transfer fixture,
// is 6+ orders of magnitude above this).
export const DUST_AMOUNT_THRESHOLD = 1e-6

function txGroupKey(e: NormalizedEvent): string {
  return `${e.chain}:${e.txHash}`
}

// PURE. Classifies every event in `events` (transaction-first: grouped by chain+txHash before any
// per-token netting, requirement #2) into exactly one EventClassification. Never mutates or
// reorders `events` — the returned array is in the SAME order as the input, one entry per input
// event, so `events[i]` and `result[i].event` always correspond.
export function classifyEvents(events: readonly NormalizedEvent[], context: EventClassificationContext): ClassifiedEvent[] {
  const groups = new Map<string, NormalizedEvent[]>()
  for (const e of events) {
    const key = txGroupKey(e)
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }

  const classifications = new Map<NormalizedEvent, EventClassification>()

  // NON-REGRESSION SCOPING, DISCLOSED (deliberate, explicit interpretation of requirement #5 —
  // "require two-sided reconciled wallet flow or a verified swap event"): the overwhelming majority
  // of today's REAL, already-correct closed lots come from a single inbound leg (e.g. a CEX
  // withdrawal, an airdrop later sold) or a single outbound leg (e.g. a direct-to-exchange sell)
  // with NO on-chain counterpart in the same transaction — that is simply how a great many real buys
  // and sells look on-chain, and fifoEngine has always correctly treated them as trades. Applying a
  // strict "two distinct tokens, opposite net direction, same tx" gate to EVERY event (including a
  // lone single-leg transaction) would silently reclassify a huge share of today's genuinely correct
  // buy/sell lots as `ordinary_transfer`, directly contradicting this task's own goal ("increase
  // genuine closed-lot reconstruction") and its "never lower evidence standards" hard limit. The
  // netting/two-sided-flow requirement below is therefore scoped to where it actually applies: a
  // token that has MORE THAN ONE leg within the same transaction (a real duplicate/refund/
  // intermediary-hop pattern — exactly what requirement #3 asks to net). A token with exactly ONE
  // leg in its transaction is never touched by this netting pass at all and defaults to
  // `genuine_trade_leg`, preserving today's existing, correct single-leg buy/sell behavior exactly.
  // PROVABLY-NON-ECONOMIC GUARD, DISCLOSED (production-evidence follow-up task, requirement #4 —
  // "do not classify any event out of FIFO unless its removal is provably non-economic"): a
  // same-token multi-leg group is only netted down to its majority-direction legs when the
  // opposing (minority) side is CLEARLY small relative to the majority — a genuine refund/dust
  // remainder or duplicate-log artifact, never two comparably-sized flows that could equally well
  // be two real, independent economic events sharing one transaction. When the minority side is NOT
  // clearly small, this classifier cannot prove non-economic-ness and defaults to keeping every leg
  // for that token trade-eligible — fail-closed toward inclusion, never toward exclusion.
  const MINOR_REMAINDER_MAX_RATIO = 0.5

  for (const groupEvents of groups.values()) {
    const perTokenSumInbound = new Map<string, number>()
    const perTokenSumOutbound = new Map<string, number>()
    const perTokenLegCount = new Map<string, number>()
    for (const e of groupEvents) {
      if (e.direction === 'unknown') continue
      const sums = e.direction === 'inbound' ? perTokenSumInbound : perTokenSumOutbound
      sums.set(e.contract, (sums.get(e.contract) ?? 0) + e.amount)
      perTokenLegCount.set(e.contract, (perTokenLegCount.get(e.contract) ?? 0) + 1)
    }

    for (const e of groupEvents) {
      if (e.direction === 'unknown') {
        classifications.set(e, 'unknown')
        continue
      }
      if (e.amount < DUST_AMOUNT_THRESHOLD) {
        classifications.set(e, 'dust_non_economic')
        continue
      }
      const legCountForToken = perTokenLegCount.get(e.contract) ?? 0
      if (legCountForToken <= 1) {
        // The only leg of this token in this transaction — no duplicate/refund/hop pattern to net
        // against. Preserves today's existing single-leg buy/sell behavior exactly.
        classifications.set(e, 'genuine_trade_leg')
        continue
      }
      // MULTIPLE legs of the SAME token within one transaction, DISCLOSED (requirements #3/#4): a
      // real duplicate/split transfer (multiple legs, same direction, netting the same way — e.g.
      // the Classic/Slipstream multi-transfer swap-leg pattern already handled at the receipt-decode
      // layer, or a provider reporting a batched transfer as separate log entries), a refund of
      // unused input, or a router intermediary relaying this exact token through more than one hop.
      const sumInbound = perTokenSumInbound.get(e.contract) ?? 0
      const sumOutbound = perTokenSumOutbound.get(e.contract) ?? 0
      const net = sumInbound - sumOutbound
      const netIsZero = Math.abs(net) <= DUST_AMOUNT_THRESHOLD
      const touchesRouter = context.knownDexRouterAddresses.has(e.toAddress.toLowerCase())
        || context.knownDexRouterAddresses.has(e.fromAddress.toLowerCase())
      if (netIsZero) {
        // PERFECT PASS-THROUGH, DISCLOSED: inbound and outbound legs for this token cancel out
        // EXACTLY — the strongest, least-ambiguous non-economic signal there is (a genuine
        // round-trip contributes nothing to the wallet's position). Every leg for this token is
        // excluded, never just one side.
        classifications.set(e, touchesRouter ? 'router_intermediary' : 'ordinary_transfer')
        continue
      }
      const majoritySum = net > 0 ? sumInbound : sumOutbound
      const minoritySum = net > 0 ? sumOutbound : sumInbound
      const minorityIsProvablyNonEconomic = majoritySum > 0 && minoritySum <= majoritySum * MINOR_REMAINDER_MAX_RATIO
      if (!minorityIsProvablyNonEconomic) {
        // Cannot prove either side is non-economic — the two sides are comparably sized, which
        // could equally well be two real, independent economic events sharing one transaction.
        // Keep every leg for this token trade-eligible rather than guess (requirement #4).
        classifications.set(e, 'genuine_trade_leg')
        continue
      }
      const legAgreesWithNet = (net > 0 && e.direction === 'inbound') || (net < 0 && e.direction === 'outbound')
      // The provably-minor, non-net-contributing half of this same-token pattern — classified
      // `router_intermediary` when it actually touches a known DEX router (a real routing hop), or
      // `ordinary_transfer` otherwise (a same-token duplicate/refund/wash flow not involving a
      // known router). The majority side, which genuinely accounts for the token's real net flow,
      // always stays genuine_trade_leg.
      classifications.set(e, legAgreesWithNet ? 'genuine_trade_leg' : (touchesRouter ? 'router_intermediary' : 'ordinary_transfer'))
    }
  }

  // DISTRIBUTION/AIRDROP RECLASSIFICATION, DISCLOSED (requirement #1's distribution_airdrop
  // category, extended per the production-evidence follow-up task's requirement #2 — "audit
  // directionally: inbound airdrop, outbound distribution... do not treat every outbound transfer
  // as a sell"): a real, positive, deterministic signal — repeated transfers of the exact same
  // (chain, contract, amount, DIRECTION) across DIFFERENT transactions, where the wallet has NEVER
  // once moved that same token the OPPOSITE direction. Symmetric by design: repeated INBOUND legs
  // with no outbound counterpart ever is the canonical "wallet receives an airdrop" signature;
  // repeated OUTBOUND legs with no inbound counterpart ever is the canonical "wallet IS the
  // distributor, fanning identical amounts out to many recipients" signature — neither is a real
  // trade, and treating the outbound case as a genuine unmatched sell (as fifoEngine's old
  // every-outbound-is-a-sell behavior did) inflates unmatched-sell counts with events that were
  // never sales at all. Both directions reuse the single `distribution_airdrop` category (this
  // module's enum has no separate "distribution" vs "airdrop" value) — `auditDistributionDirection`
  // below reports the real inbound/outbound split for observability. Reclassifies from EITHER
  // `genuine_trade_leg` (the common case: each drop is a lone leg in its own transaction) or
  // `ordinary_transfer`/`dust_non_economic` (a same-tx pattern, or a tiny repeated amount, that also
  // happens to repeat) — this is the one deliberate exception to "only ever narrows FIFO eligibility
  // within a transaction": a repeating cross-transaction pattern is real, independent evidence a
  // single-transaction view can never see. Never reclassifies `router_intermediary`, `bridge`, or
  // `lp_staking` — those already have their own real, non-guessed exclusion reason.
  const outboundTokenKeys = new Set(
    events.filter((e) => e.direction === 'outbound').map((e) => `${e.chain}:${e.contract.toLowerCase()}`),
  )
  const inboundTokenKeys = new Set(
    events.filter((e) => e.direction === 'inbound').map((e) => `${e.chain}:${e.contract.toLowerCase()}`),
  )
  const RECLASSIFIABLE: ReadonlySet<EventClassification> = new Set(['genuine_trade_leg', 'ordinary_transfer', 'dust_non_economic'])
  const candidateGroups = new Map<string, NormalizedEvent[]>()
  for (const e of events) {
    const classification = classifications.get(e)
    if (!classification || !RECLASSIFIABLE.has(classification)) continue
    const key = `${e.chain}:${e.contract.toLowerCase()}:${e.amount}:${e.direction}`
    const list = candidateGroups.get(key)
    if (list) list.push(e)
    else candidateGroups.set(key, [e])
  }
  for (const [key, list] of candidateGroups) {
    if (list.length < 2) continue
    const [chain, contract, , direction] = key.split(':')
    const oppositeTokenKeys = direction === 'inbound' ? outboundTokenKeys : inboundTokenKeys
    if (oppositeTokenKeys.has(`${chain}:${contract}`)) continue
    for (const e of list) classifications.set(e, 'distribution_airdrop')
  }

  return events.map((event) => ({ event, classification: classifications.get(event) ?? 'unknown' }))
}

// DIRECTIONAL DISTRIBUTION AUDIT, DISCLOSED (requirement #2): a real, observability-only split of
// every `distribution_airdrop`-classified event by direction — inbound (wallet received an
// airdrop) vs outbound (wallet distributed to others) — plus, for completeness, the same
// inbound/outbound split for `ordinary_transfer` and `genuine_trade_leg`. Never changes any
// classification itself; purely a reporting view over `classifyEvents`' own output.
export type DirectionalClassificationAudit = {
  inboundAirdrop: number
  outboundDistribution: number
  ordinaryWalletTransfer: number
  genuineTradeLeg: number
}
export function auditDistributionDirection(classified: readonly ClassifiedEvent[]): DirectionalClassificationAudit {
  const audit: DirectionalClassificationAudit = { inboundAirdrop: 0, outboundDistribution: 0, ordinaryWalletTransfer: 0, genuineTradeLeg: 0 }
  for (const c of classified) {
    if (c.classification === 'distribution_airdrop') {
      if (c.event.direction === 'inbound') audit.inboundAirdrop += 1
      else if (c.event.direction === 'outbound') audit.outboundDistribution += 1
      continue
    }
    if (c.classification === 'ordinary_transfer') audit.ordinaryWalletTransfer += 1
    else if (c.classification === 'genuine_trade_leg') audit.genuineTradeLeg += 1
  }
  return audit
}

// FIFO-ELIGIBLE CLASSIFICATIONS, DISCLOSED (requirement #6): only these two categories may enter
// FIFO. `unknown` is included per this module's own conservatism disclosure above — this classifier
// currently never actually assigns it, but a caller must never silently drop a leg this pass
// couldn't positively classify as non-trade.
// DUST NO LONGER A PRE-FIFO EXCLUSION, DISCLOSED (production-evidence follow-up task — confirmed
// bug): a real closed lot was lost because its BUY-side event's raw on-chain amount fell under
// DUST_AMOUNT_THRESHOLD and was classified `dust_non_economic`, which previously ALSO meant
// "removed from FIFO" — while its SELL-side event (a normal-sized amount) stayed in and became an
// unmatched sell. Dust/materiality is a DISPLAY/reporting judgment (is this amount meaningful
// enough to show, to count toward "significant" stats, to publish) — it must never delete a
// structurally valid buy/sell event before FIFO gets to match it. `dust_non_economic` is now
// FIFO-eligible: the classification itself is unchanged (still computed the same way, still used
// to exclude dust from the structural-coverage denominator and from display/stats — see
// countByClassification's callers), only its effect on FIFO admission changed.
const FIFO_ELIGIBLE: ReadonlySet<EventClassification> = new Set(['genuine_trade_leg', 'unknown', 'dust_non_economic'])

export function isFifoEligible(classification: EventClassification): boolean {
  return FIFO_ELIGIBLE.has(classification)
}

// PURE. Filters `events` down to only FIFO-eligible legs, preserving original order/dedupe —
// requirement #6's "ordinary transfers/distributions/bridges/LP activity must never enter FIFO",
// requirement's own "preserve deterministic ordering and dedupe" hard limit.
export function filterToFifoEligible(events: readonly NormalizedEvent[], context: EventClassificationContext): NormalizedEvent[] {
  const classified = classifyEvents(events, context)
  return classified.filter((c) => isFifoEligible(c.classification)).map((c) => c.event)
}

// Compact per-classification counts — the `eventsByClassification` shape requirement #9's audit
// asks for.
export function countByClassification(classified: readonly ClassifiedEvent[]): Record<EventClassification, number> {
  const counts: Record<EventClassification, number> = {
    genuine_trade_leg: 0, ordinary_transfer: 0, distribution_airdrop: 0, router_intermediary: 0,
    bridge: 0, lp_staking: 0, dust_non_economic: 0, unknown: 0,
  }
  for (const c of classified) counts[c.classification] += 1
  return counts
}

// STRUCTURAL COVERAGE DENOMINATOR AUDIT, DISCLOSED (production-evidence follow-up task,
// requirements #3/#4): the public PnL gate's "structural coverage" must be computed from GENUINE
// trade evidence only — verified closed lots and genuinely-unmatched trade legs — never inflated by
// events that were never trades to begin with. `distribution_airdrop`/`ordinary_transfer`/
// `router_intermediary`/`bridge`/`lp_staking` are already excluded from FIFO entirely (see
// FIFO_ELIGIBLE above), so they can never appear in `fifoUnmatchedBuys`/`fifoUnmatchedSells` — the
// one remaining source of denominator inflation is `dust_non_economic`, which (per this same task's
// requirement #1) DOES now enter FIFO, and can legitimately end up as one of FIFO's own unmatched
// stragglers. Since fifoEngine reports only a COUNT (never which specific events remained
// unmatched), `genuineUnmatchedBuys/Sells` is a real, disclosed, clamped-at-zero UPPER-BOUND
// approximation: the raw unmatched count minus the total number of dust-classified events on that
// side that were fed into FIFO. This can only ever REDUCE the denominator toward genuine evidence,
// never inflate it, and is exact whenever fewer dust events exist than the raw unmatched count.
export type StructuralCoverageAudit = {
  rawUnmatchedBuys: number
  rawUnmatchedSells: number
  genuineUnmatchedBuys: number
  genuineUnmatchedSells: number
  excludedNonTradeBuys: Partial<Record<EventClassification, number>>
  excludedNonTradeSells: Partial<Record<EventClassification, number>>
  structuralCoverageNumerator: number
  structuralCoverageDenominator: number
  structuralCoverage: number | null
}

const NON_TRADE_CLASSIFICATIONS: readonly EventClassification[] = ['distribution_airdrop', 'ordinary_transfer', 'router_intermediary', 'bridge', 'lp_staking']

// SUPERSEDED, DISCLOSED (exact-unmatched-identity follow-up task): this was a REPORTING-ONLY
// approximation — fifoEngine previously exposed only unmatched COUNTS, never which specific events
// remained unmatched, so `dustInbound`/`dustOutbound` here was an upper-bound guess (total dust
// events fed into FIFO, not necessarily the ones that ended up unmatched). Now that fifoEngine
// additively exposes `unmatchedBuyEvents`/`unmatchedSellEvents` (real source identities — see
// UnmatchedEventIdentity in fifoEngine/types.ts), `computeExactStructuralCoverageAudit` below joins
// those exact identities back to this module's own classification and replaces this approximation.
// Kept only for backward compatibility with any existing caller/test that hasn't migrated.
export function computeStructuralCoverageAudit(
  classified: readonly ClassifiedEvent[],
  closedLotCount: number,
  fifoUnmatchedBuys: number,
  fifoUnmatchedSells: number,
): StructuralCoverageAudit {
  const excludedNonTradeBuys: Partial<Record<EventClassification, number>> = {}
  const excludedNonTradeSells: Partial<Record<EventClassification, number>> = {}
  for (const cls of NON_TRADE_CLASSIFICATIONS) { excludedNonTradeBuys[cls] = 0; excludedNonTradeSells[cls] = 0 }
  let dustInbound = 0
  let dustOutbound = 0
  for (const c of classified) {
    if (NON_TRADE_CLASSIFICATIONS.includes(c.classification)) {
      if (c.event.direction === 'inbound') excludedNonTradeBuys[c.classification] = (excludedNonTradeBuys[c.classification] ?? 0) + 1
      else if (c.event.direction === 'outbound') excludedNonTradeSells[c.classification] = (excludedNonTradeSells[c.classification] ?? 0) + 1
      continue
    }
    if (c.classification === 'dust_non_economic') {
      if (c.event.direction === 'inbound') dustInbound += 1
      else if (c.event.direction === 'outbound') dustOutbound += 1
    }
  }
  const genuineUnmatchedBuys = Math.max(0, fifoUnmatchedBuys - dustInbound)
  const genuineUnmatchedSells = Math.max(0, fifoUnmatchedSells - dustOutbound)
  const structuralCoverageNumerator = closedLotCount
  const structuralCoverageDenominator = structuralCoverageNumerator + genuineUnmatchedBuys + genuineUnmatchedSells
  return {
    rawUnmatchedBuys: fifoUnmatchedBuys,
    rawUnmatchedSells: fifoUnmatchedSells,
    genuineUnmatchedBuys,
    genuineUnmatchedSells,
    excludedNonTradeBuys,
    excludedNonTradeSells,
    structuralCoverageNumerator,
    structuralCoverageDenominator,
    structuralCoverage: structuralCoverageDenominator > 0 ? structuralCoverageNumerator / structuralCoverageDenominator : null,
  }
}

// EXACT UNMATCHED ATTRIBUTION, DISCLOSED (exact-unmatched-identity follow-up task): joins
// fifoEngine's own real unmatched source identities (UnmatchedEventIdentity — chain/txHash/token/
// direction/amount) back to THIS classifier's own per-event classification, so the structural
// coverage denominator reflects EXACTLY which unmatched buys/sells are genuine trade evidence,
// never an approximation.
//
// JOIN STRATEGY, DISCLOSED: keyed by (chain, txHash, token, direction) — the identity fields both
// sides genuinely share. When exactly one classified event matches that key, the join is
// unambiguous regardless of amount (a partially-consumed buy/sell's remaining/unmatched amount
// legitimately differs from the original event's full amount — see UnmatchedEventIdentity's own
// header). When MULTIPLE classified events share that key (a real same-tx/same-token/same-direction
// multi-leg pattern), the join falls back to an EXACT amount match; if that's still ambiguous (zero
// or more than one exact match), or no candidate exists at all, this is an honest JOIN FAILURE —
// per requirement #8's fail-closed rule, the event is treated as `unknown` and counted in
// `unmatchedIdentityJoinFailures`, never silently excluded or guessed into a non-trade category.
export type ExactUnmatchedCategory = EventClassification | 'genuine_unmatched_trade'

export type ExactStructuralCoverageAudit = {
  rawUnmatchedBuys: number
  rawUnmatchedSells: number
  genuineUnmatchedBuys: number
  genuineUnmatchedSells: number
  excludedUnmatchedByClassification: Partial<Record<EventClassification, number>>
  unmatchedIdentityJoinFailures: number
  structuralCoverageNumerator: number
  structuralCoverageDenominator: number
  structuralCoverage: number | null
}

function unmatchedJoinGroupKey(chain: string, txHash: string, token: string, direction: 'inbound' | 'outbound'): string {
  return `${chain}:${txHash}:${token.toLowerCase()}:${direction}`
}

function joinOneSide(
  identities: readonly UnmatchedEventIdentity[],
  groups: Map<string, ClassifiedEvent[]>,
): { genuine: number; excludedByClassification: Partial<Record<EventClassification, number>>; joinFailures: number } {
  const excludedByClassification: Partial<Record<EventClassification, number>> = {}
  let genuine = 0
  let joinFailures = 0
  for (const identity of identities) {
    const key = unmatchedJoinGroupKey(identity.chain, identity.txHash, identity.token, identity.direction)
    const candidates = groups.get(key) ?? []
    let resolved: EventClassification | null = null
    if (candidates.length === 1) {
      resolved = candidates[0].classification
    } else if (candidates.length > 1) {
      const exactMatches = candidates.filter((c) => Math.abs(c.event.amount - identity.amount) < 1e-12)
      if (exactMatches.length === 1) resolved = exactMatches[0].classification
      // 0 or >1 exact matches among multiple candidates: genuinely ambiguous — falls through to
      // the join-failure path below (resolved stays null), never guessed.
    }
    if (resolved === null) {
      // FAIL CLOSED, DISCLOSED (requirement #8): no candidate at all, or a genuinely ambiguous
      // multi-candidate group — this event remains `unknown` and continues counting as genuine
      // (blocking) unmatched evidence, exactly as an un-joinable event must.
      joinFailures += 1
      genuine += 1
      continue
    }
    if (resolved === 'genuine_trade_leg' || resolved === 'unknown') {
      genuine += 1
    } else {
      excludedByClassification[resolved] = (excludedByClassification[resolved] ?? 0) + 1
    }
  }
  return { genuine, excludedByClassification, joinFailures }
}

// UNMATCHED EVIDENCE AUDIT, DISCLOSED (bounded-history follow-up task, requirements #1-#4): the
// exact join above (computeExactStructuralCoverageAudit) only ever separates unmatched evidence
// into "proven non-trade" vs "genuine" — but a real, unsold unmatched BUY is not evidence of a
// problem at all, it is an open position (the wallet still holds it) and must never block realized
// PnL on already-closed lots. Likewise a real unmatched SELL can legitimately have no matching buy
// in the fetched history simply because this scan's fetch window is bounded (PROVIDER_FETCH_WINDOW,
// a fixed number of days) and the acquisition happened before that boundary — a bounded-history
// evidence gap, not a structural defect. This function splits unmatched evidence one level finer:
//
//   Buys:  open_position_inventory (default for every resolved, non-excluded buy — an unsold buy
//            is definitionally still-held inventory) | unknown (join failure, fail-closed, still
//            blocks) | structurally_invalid_buy (declared for completeness/forward-compatibility,
//            per this module's own existing convention for `bridge`/`lp_staking` above — never
//            actually assigned here, because this module has no positive signal that would prove a
//            buy structurally invalid rather than just unsold; guessing one would violate the
//            existing "never guess" hard limit this file already documents).
//   Sells: transfer_distribution (the join resolved to a proven non-trade classification — reuses
//            excludedByClassification exactly as computeExactStructuralCoverageAudit already does)
//            | pre_window_inventory_exit (see PRE_WINDOW DETECTION below) | unknown (join failure,
//            OR a genuine trade-leg sell with no earlier buy that does NOT meet the conservative
//            pre-window signal — fail-closed: this function cannot prove it's a bounded-history gap,
//            so it stays blocking rather than being silently excluded) | structurally_invalid_sell
//            (declared, never assigned, same rationale as structurally_invalid_buy above).
//
// PRE-WINDOW DETECTION, DISCLOSED (requirement #3, all four conditions required together):
//   1. No earlier BUY-classified event exists anywhere in `classified` (the full fetched event set,
//      not just FIFO-eligible ones) for the same (chain, token) at a timestamp strictly before this
//      sell's own timestamp.
//   2. The provider window reached its configured boundary: the EARLIEST event this scan ever
//      fetched (any token, any direction) is at or before `windowStartTimestamp +
//      windowBoundaryToleranceMs` — i.e. the fetch genuinely reached back to (or past) the
//      configured window edge, rather than the wallet simply having a short real history. Without
//      this check, "no earlier buy" alone cannot distinguish "acquired before the window" from "was
//      never really bought" — the boundary signal is what makes the exclusion conservative rather
//      than a guess.
//   3. The sell itself occurred inside the fetched/scanned window (always true for any event this
//      function ever sees, since `classified` only ever contains events the scan actually fetched —
//      kept as an explicit, named condition for auditability, not a no-op).
//   4. No contradictory same-window evidence: this sell is never the join-failure/ambiguous case
//      (condition already handled by the `unknown` fallback above) and never itself resolves to a
//      proven non-trade classification (handled by `transfer_distribution` above) — by construction,
//      reaching the pre-window check at all means neither contradiction applies.
// Never invents a cost basis for a pre-window exit — its FIFO-computed realizedPnlUsd contribution
// (none; it was never matched to a lot) is completely untouched by this classification pass, which
// only feeds the structural-coverage/gate DENOMINATOR, never fifoEngine's own PnL arithmetic.
export type UnmatchedBuyCategory = 'open_position_inventory' | 'structurally_invalid_buy' | 'unknown'
export type UnmatchedSellCategory = 'pre_window_inventory_exit' | 'pre_window_inventory_exit_unproven_due_to_truncation' | 'transfer_distribution' | 'structurally_invalid_sell' | 'unknown'

// HISTORY COVERAGE MODEL, DISCLOSED (boundary-model follow-up task — confirmed production root
// cause: Base's Alchemy fetch hit MAX_RAW_EVENTS_PER_PROVIDER (400/400) with both providers
// otherwise healthy, `earliestFetchedEventTimestamp` therefore reflected the CAP, not the wallet's
// real history, `windowBoundaryProven` flipped false purely from that truncation, and 110
// legitimate pre-window exits were reclassified `unknown` and hard-blocked an otherwise-verified
// 23/24-lot sample). `earliestFetchedEventTimestamp` alone can never distinguish "this wallet's
// real history is short" from "a bounded page truncated it" — a provider/direction that returned
// exactly its cap could easily have MORE, older events it simply never got to report. Coverage is
// now classified explicitly, from real signals the caller supplies (never inferred from timestamps
// alone):
//   'exhaustive' — no provider/direction hit its event cap, no provider failed, and the earliest
//     fetched event genuinely reached the configured window boundary. The only status that may
//     grant a full, proven pre_window_inventory_exit classification.
//   'truncated'  — every provider succeeded (`ok: true`), but at least one provider/direction hit
//     its bounded-page event cap, so the fetch cannot prove it reached the window edge even though
//     nothing failed. A sell that would otherwise qualify is now `pre_window_inventory_exit_
//     unproven_due_to_truncation` — disclosed, excluded from hard blocking, but never presented as
//     a proven full-window fact.
//   'partial'    — at least one provider genuinely failed (a real fetch error, not a cap) — the
//     fetched set itself is suspect, not just its age boundary. Fails closed exactly as before this
//     task (unchanged, unmatched sells stay `unknown` and continue to block).
//   'unknown'    — every provider succeeded, nothing was capped, but the earliest fetched event
//     still didn't reach the window boundary — a genuinely short real history, OR (rarely) no
//     timestamped events at all. Fails closed exactly as before this task (unchanged).
export type HistoryCoverageStatus = 'exhaustive' | 'truncated' | 'partial' | 'unknown'

export type UnmatchedEvidenceAuditContext = {
  // Epoch ms. The configured fetch window's start boundary for this scan (scanTimestamp minus the
  // configured window days) — real, computed by the caller from the same fixed constant the
  // provider fetch itself used, never guessed here.
  windowStartTimestamp: number
  // Epoch ms tolerance around windowStartTimestamp for treating "the earliest fetched event" as
  // having reached the boundary — real wallets rarely have an event at the exact millisecond a
  // window opens. Defaults to 3 days: small relative to the (currently 90-day) window, chosen to
  // absorb normal on-chain gaps without loosening the check into "any short history counts".
  windowBoundaryToleranceMs?: number
  scanWindowDays?: number
  // HISTORY COVERAGE INPUTS, DISCLOSED, ADDITIVE (boundary-model follow-up task): real signals only
  // — this module has no visibility into provider fetch results itself, so the caller (which does)
  // supplies them. Both default to false (unset) for backward compatibility with any existing
  // caller that hasn't been updated — that caller gets the OLD 'exhaustive'-or-'unknown' behavior
  // exactly as before, never a silently different classification.
  anyProviderAtEventCap?: boolean
  anyProviderFetchFailed?: boolean
}

export type UnmatchedEvidenceAudit = {
  openPositionBuys: number
  structurallyInvalidBuys: number
  unknownBuys: number
  preWindowInventoryExits: number
  // TRUNCATED-HISTORY DISCLOSURE, DISCLOSED, ADDITIVE (boundary-model follow-up task): sells that
  // would have qualified as pre_window_inventory_exit but coverage was only 'truncated' — real
  // count, never folded into `preWindowInventoryExits` (which would falsely claim a proven full
  // window) and never folded into `unknownSells`/the blocking denominator (which would hard-block
  // an otherwise-verified sample over provider page-cap truncation, the confirmed production bug).
  preWindowInventoryExitsUnprovenDueToTruncation: number
  transferDistributionSells: Partial<Record<EventClassification, number>>
  structurallyInvalidSells: number
  unknownSells: number
  unmatchedIdentityJoinFailures: number
  // BLOCKING COUNTS, DISCLOSED (requirement #4): only these two feed the structural-consistency
  // gate's denominator/decision below — open positions and pre-window exits (proven or
  // truncation-disclosed) are disclosed but never invalidate an independently verified closed lot.
  structurallyInvalidOrUnknownBuys: number
  structurallyInvalidOrUnknownSells: number
  structuralCoverageNumerator: number
  structuralCoverageDenominator: number
  structuralCoverage: number | null
  // HISTORY COVERAGE STATUS, DISCLOSED (boundary-model follow-up task): see HistoryCoverageStatus's
  // own header for the full four-way disclosure this replaces a single boolean with.
  historyCoverageStatus: HistoryCoverageStatus
  // WINDOW BOUNDARY PROOF, DISCLOSED (bounded-sample-gate follow-up task, requirement #2): real —
  // true ONLY when historyCoverageStatus is 'exhaustive' (the earliest fetched event genuinely
  // reached the configured window's start boundary within tolerance, with nothing capped or
  // failed). UNCHANGED MEANING from before this task — still never true for a truncated fetch, so a
  // caller reading this field alone never sees a false full-window claim.
  windowBoundaryProven: boolean
  // BOUNDED-SAMPLE ADMISSION SIGNAL, DISCLOSED, ADDITIVE (boundary-model follow-up task): true for
  // BOTH 'exhaustive' and 'truncated' coverage — the real signal the bounded (partial, 90-day)
  // sample gate should admit on, since a page-capped-but-otherwise-healthy fetch is disclosed via
  // `historyCoverageStatus`/`preWindowInventoryExitsUnprovenDueToTruncation` above rather than
  // silently hard-blocking. Still false (fail-closed, unchanged from before this task) for
  // 'partial' (a genuine provider failure) and 'unknown' (a fetch that proved nothing, cap or not).
  boundedSampleWindowSafe: boolean
  // DIAGNOSTIC ONLY, ADDITIVE, DISCLOSED (window-boundary-proof audit task): the real evidence
  // behind `windowBoundaryProven` above and behind every sell this pass declined to classify as a
  // pre-window exit. Changes NO decision — every counter above, `windowBoundaryProven` itself, and
  // the gate that reads it are byte-for-byte unchanged. Exists so a production log can attribute a
  // `preWindowInventoryExits: 110 -> 0` swing to its exact cause instead of leaving four candidate
  // explanations indistinguishable. See WindowBoundaryProofDiagnostics' own header.
  boundaryProofDiagnostics: WindowBoundaryProofDiagnostics
}

// DIAGNOSTIC-ONLY EVIDENCE, DISCLOSED (window-boundary-proof audit task). CONFIRMED MECHANISM THIS
// MAKES OBSERVABLE: `boundaryReached` below is a SINGLE boolean derived from one number — the
// earliest event this scan happened to receive. Because every `pre_window_inventory_exit` decision
// is gated on it, that one boolean flipping reclassifies EVERY otherwise-qualifying unmatched sell
// to `unknown` at once (preWindowInventoryExits -> 0, unknownSells += the same count,
// windowBoundaryProven -> false). The counters below separate the four candidate explanations for
// such a swing, which the audit's existing fields cannot tell apart:
//
//   * `sellsBlockedSolelyByUnprovenBoundary` — sells that resolved, are trade-eligible, and have no
//     earlier in-window buy, and were therefore counted `unknown` ONLY because `boundaryReached`
//     was false. When this equals the whole `unknownSells` swing, the cause is the boundary flag,
//     never the join/classification pass (which ran identically).
//   * `sellsWithEarlierBuyInWindow` — sells genuinely `unknown` regardless of the boundary flag
//     (an earlier buy for the same token IS present, so bounded history cannot explain them).
//     A swing concentrated here would instead implicate matching/classification.
//   * `earliestFetchedEventTimestamp` / `fetchedHistorySpanDays` / `boundaryShortfallMs` — quantify
//     HOW the boundary failed: a fetch truncated well inside the window (span far below
//     `configuredWindowDays`, large shortfall) is provider page-cap event loss, whereas a wallet
//     whose genuine history is simply short shows a small shortfall with no truncation signal.
export type WindowBoundaryProofDiagnostics = {
  earliestFetchedEventTimestamp: number | null
  latestFetchedEventTimestamp: number | null
  windowStartTimestamp: number
  windowBoundaryToleranceMs: number
  // The exact instant `earliestFetchedEventTimestamp` had to be at or before for the boundary to be
  // considered proven — `windowStartTimestamp + windowBoundaryToleranceMs`, surfaced so a log reader
  // never has to re-derive it.
  boundaryThresholdTimestamp: number
  // How far the earliest fetched event fell SHORT of proving the boundary, in ms: 0 when proven,
  // null when this scan fetched no timestamped events at all. A large positive value is the direct
  // measure of missing older history.
  boundaryShortfallMs: number | null
  // Real span of what was actually fetched (latest - earliest). A span far below
  // `configuredWindowDays` while the window itself is unchanged is the signature of a bounded
  // single-page provider fetch truncating an active wallet's older events.
  fetchedHistorySpanDays: number | null
  configuredWindowDays: number | null
  classifiedEventsConsidered: number
  sellsBlockedSolelyByUnprovenBoundary: number
  sellsWithEarlierBuyInWindow: number
}

const DEFAULT_WINDOW_BOUNDARY_TOLERANCE_MS = 3 * 24 * 60 * 60 * 1000

function isTradeEligibleBuyClassification(classification: EventClassification): boolean {
  return classification === 'genuine_trade_leg' || classification === 'unknown' || classification === 'dust_non_economic'
}

export function computeUnmatchedEvidenceAudit(
  classified: readonly ClassifiedEvent[],
  closedLotCount: number,
  unmatchedBuyEvents: readonly UnmatchedEventIdentity[],
  unmatchedSellEvents: readonly UnmatchedEventIdentity[],
  context: UnmatchedEvidenceAuditContext,
): UnmatchedEvidenceAudit {
  const groups = new Map<string, ClassifiedEvent[]>()
  let earliestEventTimestamp: number | null = null
  // DIAGNOSTIC ONLY, ADDITIVE: tracked alongside the existing earliest scan, never read by any
  // decision below — see WindowBoundaryProofDiagnostics' own header.
  let latestEventTimestamp: number | null = null
  let timestampedEventsConsidered = 0
  const earliestBuyTimestampByToken = new Map<string, number>()
  for (const c of classified) {
    if (c.event.direction === 'unknown') continue
    const key = unmatchedJoinGroupKey(c.event.chain, c.event.txHash, c.event.contract, c.event.direction)
    const list = groups.get(key)
    if (list) list.push(c)
    else groups.set(key, [c])
    const ts = Date.parse(c.event.timestamp)
    if (Number.isFinite(ts)) {
      timestampedEventsConsidered += 1
      if (latestEventTimestamp === null || ts > latestEventTimestamp) latestEventTimestamp = ts
      if (earliestEventTimestamp === null || ts < earliestEventTimestamp) earliestEventTimestamp = ts
      if (c.event.direction === 'inbound' && isTradeEligibleBuyClassification(c.classification)) {
        const tokenKeyStr = `${c.event.chain}:${c.event.contract.toLowerCase()}`
        const existing = earliestBuyTimestampByToken.get(tokenKeyStr)
        if (existing === undefined || ts < existing) earliestBuyTimestampByToken.set(tokenKeyStr, ts)
      }
    }
  }
  const tolerance = context.windowBoundaryToleranceMs ?? DEFAULT_WINDOW_BOUNDARY_TOLERANCE_MS
  const boundaryReached = earliestEventTimestamp !== null && earliestEventTimestamp <= context.windowStartTimestamp + tolerance

  // HISTORY COVERAGE CLASSIFICATION, DISCLOSED (boundary-model follow-up task): a genuine provider
  // failure is checked FIRST and unconditionally fails closed (`'partial'`) — a fetch that didn't
  // even complete cleanly is not merely "boundary-unproven", the returned event set itself is
  // suspect. Only once every provider has genuinely SUCCEEDED does a page-cap on any of them
  // demote the result to `'truncated'` rather than letting `boundaryReached` — which cannot tell a
  // capped fetch from a short real history — silently decide `'exhaustive'` vs `'unknown'` alone.
  const historyCoverageStatus: HistoryCoverageStatus = context.anyProviderFetchFailed
    ? 'partial'
    : context.anyProviderAtEventCap
      ? 'truncated'
      : boundaryReached
        ? 'exhaustive'
        : 'unknown'
  const boundedSampleWindowSafe = historyCoverageStatus === 'exhaustive' || historyCoverageStatus === 'truncated'

  const resolveJoin = (identity: UnmatchedEventIdentity): EventClassification | null => {
    const key = unmatchedJoinGroupKey(identity.chain, identity.txHash, identity.token, identity.direction)
    const candidates = groups.get(key) ?? []
    if (candidates.length === 1) return candidates[0].classification
    if (candidates.length > 1) {
      const exactMatches = candidates.filter((c) => Math.abs(c.event.amount - identity.amount) < 1e-12)
      if (exactMatches.length === 1) return exactMatches[0].classification
    }
    return null
  }

  let openPositionBuys = 0
  let unknownBuys = 0
  let joinFailures = 0
  for (const identity of unmatchedBuyEvents) {
    const resolved = resolveJoin(identity)
    if (resolved === null) { unknownBuys += 1; joinFailures += 1; continue }
    // Every resolved, joined buy is definitionally still-held inventory — see this function's own
    // header for why `structurally_invalid_buy` is declared but never assigned.
    openPositionBuys += 1
  }

  let preWindowInventoryExits = 0
  let preWindowInventoryExitsUnprovenDueToTruncation = 0
  let unknownSells = 0
  // DIAGNOSTIC ONLY, ADDITIVE: split the `else` branch below by its real cause without changing
  // which branch is taken — see WindowBoundaryProofDiagnostics' own header.
  let sellsBlockedSolelyByUnprovenBoundary = 0
  let sellsWithEarlierBuyInWindow = 0
  const transferDistributionSells: Partial<Record<EventClassification, number>> = {}
  for (const identity of unmatchedSellEvents) {
    const resolved = resolveJoin(identity)
    if (resolved === null) { unknownSells += 1; joinFailures += 1; continue }
    if (!isTradeEligibleBuyClassification(resolved)) {
      transferDistributionSells[resolved] = (transferDistributionSells[resolved] ?? 0) + 1
      continue
    }
    const tokenKeyStr = `${identity.chain}:${identity.token.toLowerCase()}`
    const earlierBuyExists = earliestBuyTimestampByToken.has(tokenKeyStr) && earliestBuyTimestampByToken.get(tokenKeyStr)! < identity.timestamp
    // CONTRADICTORY EVIDENCE, DISCLOSED (requirement: "genuine unmatched sells with contradictory
    // or invalid evidence must still block"): an earlier in-window buy for the same token directly
    // contradicts the pre-window hypothesis — this is never a coverage question, so it blocks
    // unconditionally, regardless of historyCoverageStatus.
    if (earlierBuyExists) {
      unknownSells += 1
      sellsWithEarlierBuyInWindow += 1
    } else if (historyCoverageStatus === 'exhaustive') {
      // Only status that may grant a full, proven classification — unchanged from before this task.
      preWindowInventoryExits += 1
    } else if (historyCoverageStatus === 'truncated') {
      // CONFIRMED PRODUCTION FIX (boundary-model follow-up task): a page-capped-but-healthy fetch
      // no longer collapses this whole population into `unknown`/hard-blocking — disclosed
      // separately, excluded from the blocking denominator below, never claimed as proven.
      preWindowInventoryExitsUnprovenDueToTruncation += 1
    } else {
      // 'partial' (a genuine provider failure) or 'unknown' (short real history / no timestamped
      // evidence) — fail closed exactly as before this task: cannot prove either a bounded-history
      // gap or a structural defect, stays `unknown` and continues blocking.
      unknownSells += 1
      sellsBlockedSolelyByUnprovenBoundary += 1
    }
  }

  const structurallyInvalidOrUnknownBuys = unknownBuys
  const structurallyInvalidOrUnknownSells = unknownSells
  const structuralCoverageNumerator = closedLotCount
  const structuralCoverageDenominator = structuralCoverageNumerator + structurallyInvalidOrUnknownBuys + structurallyInvalidOrUnknownSells
  return {
    openPositionBuys,
    structurallyInvalidBuys: 0,
    unknownBuys,
    preWindowInventoryExits,
    preWindowInventoryExitsUnprovenDueToTruncation,
    transferDistributionSells,
    structurallyInvalidSells: 0,
    unknownSells,
    unmatchedIdentityJoinFailures: joinFailures,
    structurallyInvalidOrUnknownBuys,
    structurallyInvalidOrUnknownSells,
    structuralCoverageNumerator,
    structuralCoverageDenominator,
    structuralCoverage: structuralCoverageDenominator > 0 ? structuralCoverageNumerator / structuralCoverageDenominator : null,
    historyCoverageStatus,
    windowBoundaryProven: historyCoverageStatus === 'exhaustive',
    boundedSampleWindowSafe,
    boundaryProofDiagnostics: {
      earliestFetchedEventTimestamp: earliestEventTimestamp,
      latestFetchedEventTimestamp: latestEventTimestamp,
      windowStartTimestamp: context.windowStartTimestamp,
      windowBoundaryToleranceMs: tolerance,
      boundaryThresholdTimestamp: context.windowStartTimestamp + tolerance,
      boundaryShortfallMs: earliestEventTimestamp === null
        ? null
        : Math.max(0, earliestEventTimestamp - (context.windowStartTimestamp + tolerance)),
      fetchedHistorySpanDays: earliestEventTimestamp === null || latestEventTimestamp === null
        ? null
        : Math.round(((latestEventTimestamp - earliestEventTimestamp) / (24 * 60 * 60 * 1000)) * 100) / 100,
      configuredWindowDays: context.scanWindowDays ?? null,
      classifiedEventsConsidered: timestampedEventsConsidered,
      sellsBlockedSolelyByUnprovenBoundary,
      sellsWithEarlierBuyInWindow,
    },
  }
}

export function computeExactStructuralCoverageAudit(
  classified: readonly ClassifiedEvent[],
  closedLotCount: number,
  unmatchedBuyEvents: readonly UnmatchedEventIdentity[],
  unmatchedSellEvents: readonly UnmatchedEventIdentity[],
): ExactStructuralCoverageAudit {
  const groups = new Map<string, ClassifiedEvent[]>()
  for (const c of classified) {
    const key = unmatchedJoinGroupKey(c.event.chain, c.event.txHash, c.event.contract, c.event.direction === 'unknown' ? 'inbound' : c.event.direction)
    if (c.event.direction === 'unknown') continue // never a candidate for a buy/sell join — has no genuine direction
    const list = groups.get(key)
    if (list) list.push(c)
    else groups.set(key, [c])
  }

  const buySide = joinOneSide(unmatchedBuyEvents, groups)
  const sellSide = joinOneSide(unmatchedSellEvents, groups)

  const excludedUnmatchedByClassification: Partial<Record<EventClassification, number>> = { ...buySide.excludedByClassification }
  for (const [cls, count] of Object.entries(sellSide.excludedByClassification) as Array<[EventClassification, number]>) {
    excludedUnmatchedByClassification[cls] = (excludedUnmatchedByClassification[cls] ?? 0) + count
  }

  const structuralCoverageNumerator = closedLotCount
  const structuralCoverageDenominator = structuralCoverageNumerator + buySide.genuine + sellSide.genuine
  return {
    rawUnmatchedBuys: unmatchedBuyEvents.length,
    rawUnmatchedSells: unmatchedSellEvents.length,
    genuineUnmatchedBuys: buySide.genuine,
    genuineUnmatchedSells: sellSide.genuine,
    excludedUnmatchedByClassification,
    unmatchedIdentityJoinFailures: buySide.joinFailures + sellSide.joinFailures,
    structuralCoverageNumerator,
    structuralCoverageDenominator,
    structuralCoverage: structuralCoverageDenominator > 0 ? structuralCoverageNumerator / structuralCoverageDenominator : null,
  }
}
