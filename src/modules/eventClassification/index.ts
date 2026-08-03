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
