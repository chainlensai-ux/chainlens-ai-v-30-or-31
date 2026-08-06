// MODULE — canonicalPnlSampleManifest (durable-canonical-sample follow-up task; identity/replay
// rewrite after the confirmed production replay failure).
//
// GOAL, DISCLOSED: production evidence proved that once accepted-evidence precedence and gate/AYRI
// agreement were both fixed, a NEW nondeterminism surfaced — newly available evidence silently
// EXPANDED the published verified sample between rescans of the SAME structural lot set. This
// module is the durable record of "the sample we already published" that a rescan reproduces
// unless an explicit refresh occurs.
//
// CONFIRMED REPLAY FAILURE THIS REWRITE FIXES, DISCLOSED: the first implementation put the matched
// lot's `amount` (a JS double) directly into the identity key as `String(amount)`. FIFO partial
// fills derive their amounts by repeated subtraction, so the SAME structural fill can serialize as
// `0.30000000000000004` on one scan and `0.3` on the next depending purely on internal accumulation
// order. Production result: a manifest with 21 lots resolved ZERO of them
// (`manifestEvidenceHydrated: false`, `canonicalSampleEvidenceUnavailable: true`) even though every
// lot was genuinely present. Fixed here (requirement #1) — the identity is now built from stable
// structural fields ONLY, plus a deterministic partial-fill ORDINAL; quantities survive as
// validation metadata in a canonical, float-noise-tolerant decimal string, never as key text.
//
// IDENTITY, DISCLOSED: keyed by (wallet, chain scope, scan-window identity, structural
// matchedLotFingerprint, pricing methodology version, manifest schema version) — deliberately NOT
// by wall-clock scan time. `scanWindowIdentity` is built from the CONFIGURED window duration and
// the pricing methodology version only — production evidence showed the scan's own latest-event
// wall-clock timestamp advancing while matchedLotFingerprint stayed identical; a manifest keyed on
// that value would miss on every rescan, the exact failure this module exists to prevent.
//
// FAIL-CLOSED, DISCLOSED: `replayManifest` is ATOMIC (requirement #3) — it either resolves EVERY
// manifest lot and returns a fully-validated published array, or it resolves none and returns
// `outcome: 'unavailable'` with a published array in which NO verified lot is published at all.
// It never partially applies, never substitutes provider evidence for a missing manifest lot, and
// never lets the current live candidate sample escape as canonical (requirement #4).

import type { MatchedLot } from '../modules/fifoEngine/types'
import {
  buildAcceptedEvidenceKey, lotIdentityVersion,
  type AcceptedEvidenceKvLike, type AcceptedEvidenceSide, type AcceptedEvidenceEnvelope, type AcceptedEvidenceValueType,
} from './acceptedEvidenceStore'
import {
  isCanonicalVerifiedPublishedLot, emptyCanonicalVerifiedPredicateReasonCounts,
  type CanonicalVerifiedPredicateReasonCounts,
} from './canonicalVerifiedLot'
import { sortLotsByCanonicalIdentity, sumQuantizedUsd } from './scanDeterminismAudit'
import { isVerifiedStablecoinAddress } from '../modules/quoteLegPricing/index'

// STABLECOIN DETERMINISTIC $1 NORMALIZATION, DISCLOSED (stablecoin-side-normalization follow-up
// task — confirmed production bug: canonical-pnl-diff-audit's own `stablecoin_side_not_unit_priced`
// warning caught a real, live example — one Base USDC side's stored/accepted total was ~$5.9705 for
// an occurrence quantity that should have valued at ~$1194.1715 at the deterministic $1/token rate
// this codebase already applies to every VERIFIED (address-checked, never symbol-guessed — see
// quoteLegPricing.ts's own stablecoinSymbolFor) stablecoin elsewhere — e.g.
// pricingAtTimeAdapter.ts's own VERIFIED-STABLECOIN SHORT-CIRCUIT, which prices a verified
// stablecoin leg at exactly $1.00/unit with zero provider call. A group's accepted-evidence total
// can silently diverge from that rate — stale evidence written before that convention existed, or
// any other upstream USD/quantity mismatch — and, being accepted evidence, would otherwise persist
// forever and keep propagating a wrong value into real, published cost basis/proceeds/realized PnL
// for that side. This is the ONE place every accepted-evidence side total is turned into a per-lot
// allocation (`allocateSideValueAcrossGroup`'s own `totalValueUsd` argument) — applying the
// normalization here means a stale/wrong stored figure for a verified stablecoin side can never
// reach publication, replay, or the manifest, regardless of which caller allocates it.
// NOT A NEW EVIDENCE STANDARD, NOT A FABRICATED VALUE, DISCLOSED: $1.00/unit for a verified
// stablecoin is the same deterministic convention this codebase already treats as ground truth
// elsewhere — this never invents a price for anything that isn't already address-verified, and
// never touches a non-stablecoin side's own accepted total.
export function stablecoinNormalizedGroupTotal(groupLots: readonly MatchedLot[], totalValueUsd: number): number {
  const representative = groupLots[0]
  if (!representative || !isVerifiedStablecoinAddress(representative.chain, representative.token)) return totalValueUsd
  return groupLots.reduce((sum, lot) => sum + lot.amount, 0)
}

// SCHEMA BUMP TO 3, GENUINELY REQUIRED, DISCLOSED (canonical-price-replay follow-up task,
// requirement #10 — "do not create a new manifest schema key merely to hide this test unless the
// stored manifest lacks required side references"). It genuinely does: a v2 manifest's per-lot
// record carried ONLY `{ key, canonicalAmount, partialFillOrdinal, partialFillGroupSize }` — there
// is no accepted-evidence key, no entry/exit price, no cost basis, no proceeds and no realized
// figure anywhere in it. That is exactly why the confirmed production replay froze lot MEMBERSHIP
// correctly (23 lots, identity fingerprint stable at e60a4d17) while the VALUES drifted
// (realized 1791.71 -> 4286.93, acceptedHistoricalPriceFingerprint 705231e0 -> fd9bffdb): replay
// republished the current scan's own lot objects, prices included, because the manifest had no
// canonical prices to restore. A v2 record cannot be upgraded in place — the required side
// references were never written — so the version is bumped and the next scan rebuilds. Both the
// first (creation) and second (replay) scan of this new schema are covered end-to-end by the
// regressions in canonicalPnlSampleManifest.test.ts.
export const CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION = 3
// UNCHANGED at 2: the structural lot IDENTITY semantics (chain/token/tx hashes/timestamps/
// partial-fill ordinal) are correct and were proven correct in production — identity replay
// succeeded for all 23 lots with zero mismatches. Only the stored VALUES were missing.
export const CANONICAL_LOT_IDENTITY_SCHEMA_VERSION = 3

// NUMERIC TOLERANCES, DISCLOSED (requirement #3's "documented numeric tolerance").
//
// Per-side prices and per-lot values are copied verbatim out of the SAME immutable accepted-evidence
// records on both the creating and the replaying scan, so they should agree bit-for-bit; the
// tolerance exists only to absorb IEEE-754 round-tripping through JSON, never to paper over a
// genuinely different price. 1e-9 is far below the smallest price this codebase treats as
// persistable, so a real disagreement can never hide inside it.
export const CANONICAL_VALUE_TOLERANCE = 1e-9
// The aggregate realized total is rounded to cents by pnlReconciliation's own `roundUsd` before it
// is stored, so comparing a freshly-summed total against a stored, cent-rounded one needs a
// cent-scale tolerance. Half a cent per lot would be unbounded across a large sample, so this is
// deliberately a flat one cent on the TOTAL — tight enough that any real value drift (the confirmed
// production case moved by ~2495 USD) fails immediately.
export const CANONICAL_TOTAL_TOLERANCE_USD = 0.01

function withinTolerance(a: number | null, b: number | null, tolerance: number): boolean {
  if (a === null || b === null) return a === b
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= tolerance
}
// Bumped only when the CANONICAL SELECTION LOGIC changes (e.g. which accepted-evidence precedence
// rule governs a lot's published price) — never for a provider-availability change, which is
// precisely the class of change this whole module exists to make invisible to the published sample.
export const CANONICAL_PRICING_METHODOLOGY_VERSION = 1
// VALUE METHODOLOGY VERSION, DISCLOSED, GENUINELY REQUIRED (canonical-manifest-compatibility
// follow-up task, issue #1 — confirmed production gap: the partial-fill allocation algorithm
// changed the VALUES a manifest's per-lot records mean, but old schema-3 manifests built before
// that change still resolved under the SAME manifest key and were replayed against it — value
// validation correctly failed them closed, but they kept being found and re-attempted every scan
// instead of a fresh, correct manifest ever getting created). Bumped whenever the VALUE
// RECONSTRUCTION ALGORITHM changes (how a lot's cost basis/proceeds are derived from accepted
// evidence — e.g. flat-copy vs proportional allocation) — never for a provider-availability change,
// and deliberately SEPARATE from `pricingMethodologyVersion` (which versions accepted-evidence
// PRECEDENCE, not value reconstruction) and from `CANONICAL_LOT_IDENTITY_SCHEMA_VERSION` (which
// stays unchanged here — structural lot identity did not change). Part of the manifest KEY itself,
// so an old-methodology manifest simply MISSES on lookup (manifestFound: false) rather than being
// found and failing replay repeatedly — a rescan under the new methodology creates a fresh manifest
// exactly like a genuine first-ever scan would.
//
// BUMPED 2 -> 3 (accepted-evidence-persistence follow-up task): the accepted-evidence writer fix
// changed what a persisted side VALUE means — from a corrupted single-sibling overwrite to a
// genuine side total allocated across siblings — so a vv2 manifest built under the old, corrupted
// semantics must never be found and replayed again (it would still carry the old corrupted totals,
// e.g. $5,066.84, even though the underlying accepted-evidence store now holds the correct schema-2
// values). Bumping this makes the old vv2 manifest key MISS on lookup, exactly the same
// manifestFound: false / fresh-manifest path this version already documents above — never a manual
// delete or refresh of the old manifest record.
//
// BUMPED 3 -> 4 (fingerprint-divergence fix task): a stored vv3 manifest's
// verifiedLotIdentityFingerprint/acceptedHistoricalPriceFingerprint/realizedPnlFingerprint were
// computed by the OLD algorithm — raw-float string interpolation over an unsorted (or
// value-dependent-sorted) lot array, summed with an order-dependent `.reduce()` — which
// scanDeterminismAudit.ts's `buildScanDeterminismAudit` no longer produces (it now sorts lots by
// canonical identity and quantizes every USD field via `quantizeUsd`/`sumQuantizedUsd` before
// hashing; see that module's own header for the confirmed production shape this fixes). The NEW
// algorithm is a genuinely different serialized meaning for the SAME stored fingerprint fields — a
// vv3 manifest's stored fingerprints can never be reproduced by the new recompute, not because its
// underlying values are wrong (they are not; per-group value/identity/evidence checks already passed
// 23/23), but because the two algorithms canonicalize differently. Bumping this makes every existing
// vv3 manifest key MISS on lookup — the same manifestFound: false / fresh-manifest path documented
// above — so the very next scan creates one fresh manifest fingerprinted correctly from the start,
// never a manual refresh or delete of the old record.
//
// BUMPED 4 -> 5 (wallet-scanner-bounded-publication follow-up task): a stored vv4 manifest's
// `acceptedHistoricalPriceFingerprint` was computed by quantizing cost/proceeds at 1e-9
// (`quantizeUsd`) — the SAME granularity as the per-group value-tolerance check
// (`CANONICAL_VALUE_TOLERANCE`). Confirmed production shape: replay resolved 23/23 lots, identity
// and realized-total fingerprints matched, stored/recomputed realized PnL both agreed at $701.47,
// yet the price fingerprint still mismatched on genuine sub-cent per-lot rounding drift the 1e-9
// quantum did not fully absorb. `scanDeterminismAudit.ts`'s price fingerprint now canonicalizes
// cost/proceeds at CENT precision (`quantizeUsdCents`) — the same precision every other published
// USD figure in this codebase already uses — while the per-group tolerance check itself is
// completely unchanged and still fails closed on any genuine, publishable divergence. This is a
// genuinely different serialized meaning for the SAME stored fingerprint field, so a vv4 manifest's
// stored price fingerprint can never be reproduced by the new (coarser) recompute — bumping makes
// every existing vv4 manifest key MISS on lookup, the same fresh-manifest path documented above,
// never a manual refresh or delete of the old record.
//
// BUMPED 5 -> 6 (stablecoin-side-normalization follow-up task): a stored vv5 manifest could carry a
// verified-stablecoin side's group total taken directly from accepted evidence, without the
// deterministic $1/token normalization `stablecoinNormalizedGroupTotal` now applies at allocation
// time — confirmed production shape: canonical-pnl-diff-audit's own `stablecoin_side_not_unit_priced`
// warning, one Base USDC side stored ~$5.9705 for an occurrence quantity that should value at
// ~$1194.1715 at $1/token. This is a genuinely different serialized meaning for the SAME stored
// `groupCostBasisUsd`/`groupProceedsUsd`/`realizedPnlUsd`/fingerprint fields whenever a verified
// stablecoin side is involved — bumping makes every existing vv5 manifest key MISS on lookup, the
// same fresh-manifest path documented above, never a manual refresh or delete of the old record.
export const CANONICAL_VALUE_METHODOLOGY_VERSION = 6

// Reuses the exact same duck-typed KV interface accepted-evidence records already use — same
// underlying store, a genuinely separate key namespace (`v1:canonical-pnl-sample-manifest:...`).
export type CanonicalSampleManifestKvLike = AcceptedEvidenceKvLike

// ============================================================================
// LOT IDENTITY (requirement #1)
// ============================================================================

type IdentityLot = Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount'>

// CANONICAL AMOUNT STRING, DISCLOSED: VALIDATION METADATA ONLY — never a key component
// (requirement #1's own "never use JS floating-point string output in the key"). Fixed 12-decimal
// normalization deliberately absorbs exactly the float-accumulation noise that broke the first
// implementation: 0.30000000000000004 and 0.3 both normalize to "0.300000000000", so a partial
// fill's quantity can still be cross-checked between runs without that check itself becoming a new
// source of spurious mismatches. Non-finite input yields the honest literal 'invalid', never a
// fabricated 0.
export function canonicalAmountString(amount: number): string {
  if (!Number.isFinite(amount)) return 'invalid'
  return amount.toFixed(12)
}

// STRUCTURAL GROUP KEY, DISCLOSED: everything that identifies a matched lot EXCEPT which slice of a
// partial fill it is — chain, normalized token, both tx hashes, both event timestamps. Two lots
// sharing this key are, by construction, two slices of the same buy tx consumed by the same sell tx
// (a real FIFO partial fill); the ordinal below is what separates them.
function structuralGroupKey(lot: IdentityLot): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt].join(':')
}

export type CanonicalLotIdentity = {
  // OCCURRENCE-GROUP KEY, DISCLOSED (grouped-multiplicity rewrite): identifies a SET of
  // structurally-identical lots, never one array position. Every lot sharing the same structural
  // identity AND the same canonical amount resolves to this SAME key — see
  // buildCanonicalLotIdentities' own header for the confirmed production failure this replaces.
  key: string
  groupKey: string
  canonicalAmount: string
  // How many structurally-identical lots share this exact key. This is the multiplicity that
  // REPLACES the old per-lot ordinal: replay matches the complete group by count, never by which
  // array slot a given lot happened to occupy.
  occurrenceCount: number
  // Total number of lots sharing the structural group key (across ALL canonical amounts within it) —
  // retained purely as a coarse "did this partial fill split differently" signal, distinct from
  // `occurrenceCount` above.
  partialFillGroupSize: number
}

// GROUPED MULTIPLICITY, DISCLOSED (grouped-multiplicity rewrite — confirmed production failure:
// `manifestFound: true, manifestApplied: false, 11 partial-fill ordinal mismatches, only 6/26
// replayed, PnL unavailable`).
//
// ROOT CAUSE, TRACED: the prior identity gave each sibling in a partial-fill group a positional
// ORDINAL, tie-broken by (canonicalAmount, closedTxHash, openedTxHash). Every member of a structural
// group shares chain/token/openedTxHash/closedTxHash BY CONSTRUCTION, so for two lots that are also
// identical in amount, ALL THREE tie-break keys are identical and the ordinal fell through to the
// stable sort's preserved INPUT ORDER — i.e. whatever order the caller's array happened to iterate
// in. The prior task correctly detected that as unresolvable (`ordinalAmbiguous`) and failed closed,
// which is exactly the 11 mismatches production reported: fully identical duplicate FIFO lots are a
// completely normal shape (one buy tx consumed by several equal-sized sells, repeated equal
// partial fills), so failing closed on them meant the manifest could essentially never apply.
//
// FIX: identical lots are no longer distinguished at all. They collapse into ONE occurrence-group
// identity carrying a multiplicity count. Replay matches the whole group (count + totals) and
// deterministically reconstructs every occurrence from the group's stored totals — array order is
// never consulted, so there is nothing left to be ambiguous about.
export function buildCanonicalLotIdentities(lots: readonly MatchedLot[]): Map<MatchedLot, CanonicalLotIdentity> {
  const structuralGroups = new Map<string, MatchedLot[]>()
  for (const lot of lots) {
    const gk = structuralGroupKey(lot)
    const existing = structuralGroups.get(gk)
    if (existing) existing.push(lot)
    else structuralGroups.set(gk, [lot])
  }

  const identities = new Map<MatchedLot, CanonicalLotIdentity>()
  for (const [gk, members] of structuralGroups) {
    // Within one structural group, sub-group by canonical amount — that pair (structural identity +
    // canonical amount) is the complete, order-independent identity of a set of identical lots.
    const byAmount = new Map<string, MatchedLot[]>()
    for (const lot of members) {
      const amount = canonicalAmountString(lot.amount)
      const existing = byAmount.get(amount)
      if (existing) existing.push(lot)
      else byAmount.set(amount, [lot])
    }
    for (const [canonicalAmount, occurrences] of byAmount) {
      const identity: CanonicalLotIdentity = {
        key: `v${CANONICAL_LOT_IDENTITY_SCHEMA_VERSION}:${gk}:amt:${canonicalAmount}`,
        groupKey: gk,
        canonicalAmount,
        occurrenceCount: occurrences.length,
        partialFillGroupSize: members.length,
      }
      // Every identical occurrence maps to the SAME identity object — by design.
      for (const lot of occurrences) identities.set(lot, identity)
    }
  }
  return identities
}

// ============================================================================
// SIDE-VALUE ALLOCATION (canonical-price-replay-values follow-up task, Part A)
// ============================================================================
//
// CONFIRMED BUG THIS SECTION FIXES: accepted evidence is keyed per TRANSACTION SIDE
// (chain/token/txHash/side/timestamp) — one record can be shared by several sibling FIFO
// partial-fill lots (one buy tx split across multiple sells, or one sell tx split across multiple
// buys). The prior manifest build/replay assigned `evidence.priceUsd` to EVERY sibling lot
// directly — the full transaction-side figure duplicated onto each slice — instead of each
// sibling's own proportional share. Confirmed production failure: entry/exit/cost-basis/proceeds/
// realized-PnL mismatches on exactly the lots that share a transaction side with another lot.
//
// VALUE SEMANTICS, DISCLOSED: this codebase's own foundational model (fifoEngine's buildLots/
// matchLotsFIFO — see index.ts's own `costBasisForPortion = (amountFromThisLot / lot.amountOpened)
// * lot.costBasisUsd`) already establishes that a per-event USD figure represents the TOTAL value
// for that whole transaction side, with each FIFO slice entitled to a QUANTITY-PROPORTIONAL share
// of it — never a flat copy. `acceptedEvidenceValueType` is recorded explicitly on every manifest
// lot record (never inferred from ambiguous historical data) and is currently always
// `'total_side_value_usd'` in this implementation, matching that established model; the
// `'unit_price_usd'` variant is a documented, supported schema value for a future evidence source
// whose own `priceUsd` genuinely IS a per-token unit price (in which case the caller would multiply
// by `lot.amount` directly, with no group allocation needed — the type field is what a future
// caller checks to know which formula applies). `AcceptedEvidenceValueType` itself now lives in
// acceptedEvidenceStore.ts (accepted-evidence-persistence follow-up task) — the actual persistence
// layer this value semantics tag is stored on — and is imported above, not redefined here.

// INTEGER-SAFE ALLOCATION, DISCLOSED (requirement #6/#7's "integer raw quantities or canonical
// decimal arithmetic" and "sum exactly back to the accepted side total, with deterministic
// remainder assignment"). `canonicalAmountString`'s own fixed 12-decimal text is parsed directly
// into a BigInt integer — never re-scaled from the raw float, which would reintroduce the exact
// noise this whole identity/allocation scheme exists to eliminate. USD values are similarly scaled
// to an 8-decimal BigInt integer before dividing, so every share is computed with exact integer
// division and the group's shares sum to the group total BIT-FOR-BIT — no accumulated float error,
// ever — with any residual (from truncation) assigned deterministically to the LAST lot in a stable
// sort order (by canonical lot identity key), never dropped, never duplicated.
const RAW_QUANTITY_SCALE = BigInt(1_000_000_000_000) // matches canonicalAmountString's 12 decimal places
const VALUE_SCALE = BigInt(100_000_000) // 8 decimal places of USD precision

function toScaledRawQuantity(amount: number): bigint {
  const str = canonicalAmountString(amount)
  if (str === 'invalid') return BigInt(0)
  const negative = str.startsWith('-')
  const unsigned = negative ? str.slice(1) : str
  const [whole, frac] = unsigned.split('.')
  const scaled = BigInt(whole) * RAW_QUANTITY_SCALE + BigInt(frac)
  return negative ? -scaled : scaled
}

function toScaledValue(value: number): bigint {
  if (!Number.isFinite(value)) return BigInt(0)
  return BigInt(Math.round(value * Number(VALUE_SCALE)))
}

function fromScaledValue(scaled: bigint): number {
  return Math.round((Number(scaled) / Number(VALUE_SCALE)) * 1e8) / 1e8
}

export type SideAllocationShare = {
  lot: MatchedLot
  allocatedValueUsd: number
  numerator: string
  denominator: string
}

// PURE, DETERMINISTIC (requirement #6): allocates ONE shared transaction-side total across every
// lot in `groupLots` (siblings sharing one accepted-evidence identity) by raw-quantity ratio.
// `groupLots` must be the FULL set of matched lots drawing from that transaction side — including
// any not currently verified/priced — so a verified sibling is never over-credited a share that
// rightly belongs to an unpriced one (see this module's own header on the allocation population).
export function allocateSideValueAcrossGroup(groupLots: readonly MatchedLot[], totalValueUsd: number): SideAllocationShare[] {
  // Stable sort key: identity fields + canonical (float-noise-free) amount — the same fields
  // buildCanonicalLotIdentities' own ordinal assignment sorts by, without needing the full-array
  // ordinal context this function's smaller `groupLots` slice doesn't have.
  const sortKey = (lot: MatchedLot) => [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt, canonicalAmountString(lot.amount)].join(':')
  const ordered = [...groupLots].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  const rawQuantities = ordered.map((lot) => toScaledRawQuantity(lot.amount))
  const totalRawQuantity = rawQuantities.reduce((sum, q) => sum + q, BigInt(0))
  const totalValueScaled = toScaledValue(totalValueUsd)
  if (totalRawQuantity <= BigInt(0) || ordered.length === 0) {
    return ordered.map((lot) => ({ lot, allocatedValueUsd: 0, numerator: '0', denominator: totalRawQuantity.toString() }))
  }
  const shares = rawQuantities.map((q) => (totalValueScaled * q) / totalRawQuantity)
  const allocatedSoFar = shares.reduce((sum, s) => sum + s, BigInt(0))
  const remainder = totalValueScaled - allocatedSoFar
  shares[shares.length - 1] += remainder
  return ordered.map((lot, i) => ({
    lot,
    allocatedValueUsd: fromScaledValue(shares[i]),
    numerator: rawQuantities[i].toString(),
    denominator: totalRawQuantity.toString(),
  }))
}

// DETERMINISTIC OCCURRENCE SPLIT, DISCLOSED (grouped-multiplicity rewrite, requirement #1's
// "deterministically reconstruct all occurrences"). Splits one occurrence-group TOTAL across its N
// structurally-identical members using the SAME integer-exact arithmetic as
// `allocateSideValueAcrossGroup` — equal shares with any truncation remainder assigned to the last
// member — so the N shares always sum back to the stored total bit-for-bit.
//
// WHY THIS IS ORDER-INDEPENDENT, DISCLOSED: the members are, by the definition of an occurrence
// group, completely identical (same chain/token/both tx hashes/both timestamps/canonical amount).
// Which physical lot object receives the remainder share is therefore not observable in any output:
// every fingerprint this codebase computes sorts its per-lot strings (see scanDeterminismAudit's own
// `acceptedHistoricalPriceFingerprint`), so the resulting MULTISET — not the assignment — is what is
// hashed. Build and replay run this identical function on the identical stored total, so they
// produce the identical multiset regardless of either scan's own array order.
export function splitGroupTotalAcrossOccurrences(totalUsd: number | null, occurrenceCount: number): Array<number | null> {
  if (totalUsd === null || !Number.isFinite(totalUsd)) return Array.from({ length: occurrenceCount }, () => null)
  if (occurrenceCount <= 0) return []
  const totalScaled = toScaledValue(totalUsd)
  const countBig = BigInt(occurrenceCount)
  const base = totalScaled / countBig
  const shares = Array.from({ length: occurrenceCount }, () => base)
  shares[shares.length - 1] += totalScaled - base * countBig
  return shares.map(fromScaledValue)
}

// The two accepted-evidence identity keys (entry + exit) a verified lot's own persisted evidence
// lives under. Recorded on the manifest per requirement #2 purely as an audit trail of WHICH
// evidence records the manifest depends on — this module never reads or writes accepted-evidence
// records itself. NOTE, DISCLOSED: two slices of the same partial fill legitimately share both of
// these keys (buildAcceptedEvidenceKey is per-tx-side, not per-lot), which is precisely why the
// stored evidence-key list must be deduplicated (requirement #2).
export function acceptedEvidenceIdentityKeysForLot(lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount'>): [string, string] {
  const version = lotIdentityVersion(lot)
  return [
    buildAcceptedEvidenceKey({ chain: lot.chain, token: lot.token, txHash: lot.openedTxHash, side: 'entry', timestamp: lot.openedAt, lotIdentityVersion: version }),
    buildAcceptedEvidenceKey({ chain: lot.chain, token: lot.token, txHash: lot.closedTxHash, side: 'exit', timestamp: lot.closedAt, lotIdentityVersion: version }),
  ]
}

// ============================================================================
// DEDUPLICATION (requirement #2)
// ============================================================================

export type DedupeResult = { unique: string[]; duplicates: string[] }

// CANONICALIZE -> SORT -> DEDUPLICATE, DISCLOSED (requirement #2, in that exact order): every key
// list this module persists or replays passes through here, so a duplicate can never silently
// inflate a manifest's own lot count or produce a phantom "missing" entry on replay. Returns the
// real duplicate keys (each reported once), never just a count.
export function dedupeKeys(keys: readonly string[]): DedupeResult {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) duplicated.add(key)
    else seen.add(key)
  }
  return { unique: [...seen].sort(), duplicates: [...duplicated].sort() }
}

export type DuplicateIdentityCheck = {
  hasDuplicates: boolean
  manifestDuplicateLotKeys: string[]
  candidateDuplicateLotKeys: string[]
  manifestDuplicateEvidenceKeys: string[]
}

// LOGGING WRAPPER, DISCLOSED: the pure check above stays testable; this is the only piece that does
// I/O. `logger.error`, not `.warn` — requirement #2 asks explicitly for CRITICAL severity.
export function logDuplicateIdentityIfAny(check: DuplicateIdentityCheck, logger: Pick<Console, 'error'> = console): void {
  if (!check.hasDuplicates) return
  logger.error('CRITICAL canonical_manifest_duplicate_identity', {
    manifestDuplicateLotKeys: check.manifestDuplicateLotKeys,
    candidateDuplicateLotKeys: check.candidateDuplicateLotKeys,
    manifestDuplicateEvidenceKeys: check.manifestDuplicateEvidenceKeys,
  })
}

// ============================================================================
// MANIFEST IDENTITY / KEYING
// ============================================================================

export function normalizeWalletAddress(walletAddress: string): string {
  return walletAddress.trim().toLowerCase()
}

export function buildChainScope(chains: readonly string[]): string {
  return [...new Set(chains.map((c) => c.toLowerCase()))].sort().join(',')
}

// SCAN-WINDOW IDENTITY, DISCLOSED (requirement #6 of the prior task — "do not invalidate the sample
// merely because the wall-clock scan time advanced"): a stable boundary tied ONLY to the configured
// window duration and the pricing methodology version, never to any observed-event timestamp. The
// canonical structural evidence boundary is already fully captured by the separate
// `matchedLotFingerprint` identity field.
export function buildScanWindowIdentity(params: { configuredWindowDays: number; pricingMethodologyVersion: number }): string {
  return `${params.configuredWindowDays}d:methodology-v${params.pricingMethodologyVersion}`
}

export type CanonicalPnlSampleManifestIdentity = {
  normalizedWalletAddress: string
  chainScope: string
  scanWindowIdentity: string
  matchedLotFingerprint: string
  pricingMethodologyVersion: number
  // GENUINELY REQUIRED, DISCLOSED — see CANONICAL_VALUE_METHODOLOGY_VERSION's own header. Part of
  // the manifest key/record identity, distinct from pricingMethodologyVersion and from the
  // structural lot-identity schema (unchanged).
  valueMethodologyVersion: number
  manifestSchemaVersion: number
}

export function buildManifestIdentity(params: {
  walletAddress: string
  chains: readonly string[]
  configuredWindowDays: number
  matchedLotFingerprint: string
  pricingMethodologyVersion?: number
  valueMethodologyVersion?: number
  manifestSchemaVersion?: number
}): CanonicalPnlSampleManifestIdentity {
  const pricingMethodologyVersion = params.pricingMethodologyVersion ?? CANONICAL_PRICING_METHODOLOGY_VERSION
  const valueMethodologyVersion = params.valueMethodologyVersion ?? CANONICAL_VALUE_METHODOLOGY_VERSION
  return {
    normalizedWalletAddress: normalizeWalletAddress(params.walletAddress),
    chainScope: buildChainScope(params.chains),
    scanWindowIdentity: buildScanWindowIdentity({ configuredWindowDays: params.configuredWindowDays, pricingMethodologyVersion }),
    matchedLotFingerprint: params.matchedLotFingerprint,
    pricingMethodologyVersion,
    valueMethodologyVersion,
    manifestSchemaVersion: params.manifestSchemaVersion ?? CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION,
  }
}

export function buildManifestKey(identity: CanonicalPnlSampleManifestIdentity): string {
  return [
    'v1:canonical-pnl-sample-manifest',
    identity.normalizedWalletAddress,
    identity.chainScope,
    identity.scanWindowIdentity,
    identity.matchedLotFingerprint,
    `v${identity.pricingMethodologyVersion}`,
    `vv${identity.valueMethodologyVersion}`,
    `s${identity.manifestSchemaVersion}`,
  ].join(':')
}

// ============================================================================
// MANIFEST RECORD
// ============================================================================

// PER-LOT CANONICAL RECORD, DISCLOSED (requirement #1). Carries three genuinely different kinds of
// field, and the distinction matters:
//
//  * IDENTITY / STRUCTURAL (`key`, `canonicalAmount`, ordinals, chain/token/tx hashes/timestamps,
//    `lotIdentityVersion`) — how to FIND this lot again and how to address its evidence records.
//  * EVIDENCE REFERENCES (`entryEvidenceKey`, `exitEvidenceKey`) — THE SOURCE OF TRUTH. Replay
//    reloads these immutable accepted-evidence records and rebuilds the lot from them.
//  * FROZEN VALUES (`entryPriceUsd` ... `realizedPnlUsd`, `evidenceQuality`, source metadata) —
//    VALIDATION ONLY, per requirement #1's explicit "stored numeric values may be used for
//    validation but must never silently override missing/invalid accepted evidence". If an
//    accepted-evidence record cannot be loaded or fails validation, replay FAILS CLOSED; it never
//    falls back to these numbers, because doing so would republish a price with no surviving
//    evidence behind it.
export type CanonicalManifestLotRecord = {
  // OCCURRENCE-GROUP RECORD, DISCLOSED (grouped-multiplicity rewrite): ONE record now describes a
  // whole set of structurally-identical lots, not a single array position. See
  // buildCanonicalLotIdentities' own header for the confirmed production failure this replaces.
  key: string
  canonicalAmount: string
  // How many identical lots this one record stands for. Replay requires the CURRENT scan to present
  // exactly this many, and reconstructs all of them from the group totals below.
  occurrenceCount: number
  partialFillGroupSize: number
  // THE GROUP'S TOTALS, DISCLOSED (requirement #1's "store the group's total allocated
  // cost/proceeds/PnL") — the authoritative frozen values. Per-occurrence figures are DERIVED from
  // these by `splitGroupTotalAcrossOccurrences`, never stored per-position, so nothing in this
  // record depends on which array slot a lot occupied.
  groupCostBasisUsd: number | null
  groupProceedsUsd: number | null
  groupRealizedPnlUsd: number | null
  // Addressing data for the two immutable accepted-evidence records this lot's values come from.
  chain: string
  token: string
  openedTxHash: string
  closedTxHash: string
  openedAt: number
  closedAt: number
  lotIdentityVersion: string
  entryEvidenceKey: string
  exitEvidenceKey: string
  // The lot-identity version each side's stored evidence record ACTUALLY carries. For a partial
  // fill several slices share one evidence key, so this is frequently a sibling slice's version
  // rather than this lot's own — recording it is what lets every slice replay strictly (see
  // AcceptedEvidenceLoader's own header). Null when no record was discoverable at build time.
  entryEvidenceLotIdentityVersion: string | null
  exitEvidenceLotIdentityVersion: string | null
  // Frozen canonical values — validation only (see this type's own header).
  entryPriceUsd: number | null
  entryValueUsd: number | null
  exitPriceUsd: number | null
  exitValueUsd: number | null
  costBasisUsd: number | null
  proceedsUsd: number | null
  realizedPnlUsd: number | null
  evidenceQuality: MatchedLot['evidenceQuality']
  entrySource: string | null
  exitSource: string | null
  pricingMethodologyVersion: number
  evidenceSchemaVersion: number | null
  // PARTIAL-FILL VALUE ALLOCATION, DISCLOSED (canonical-price-replay-values follow-up task, Part
  // A). `entrySideGroupIdentity`/`exitSideGroupIdentity` echo `entryEvidenceKey`/`exitEvidenceKey`
  // (the group this lot's side belongs to) under the field names this task's own spec asks for.
  // `costBasisUsd`/`proceedsUsd` above ARE this lot's own already-allocated share (never the raw,
  // unallocated evidence total) — `allocatedCostBasisUsd`/`allocatedProceedsUsd` are the same
  // numbers again, named explicitly for audit clarity per this task's own field list.
  acceptedEvidenceValueType: AcceptedEvidenceValueType
  entrySideGroupIdentity: string
  entrySideGroupRawQuantity: string
  entryLotRawQuantity: string
  entryAllocationNumerator: string
  entryAllocationDenominator: string
  exitSideGroupIdentity: string
  exitSideGroupRawQuantity: string
  exitLotRawQuantity: string
  exitAllocationNumerator: string
  exitAllocationDenominator: string
  allocatedCostBasisUsd: number | null
  allocatedProceedsUsd: number | null
}

export type CanonicalPnlSampleManifest = CanonicalPnlSampleManifestIdentity & {
  lotIdentitySchemaVersion: number
  manifestVersion: number
  priorManifestVersion: number | null
  verifiedLotIdentityKeys: string[]
  verifiedLotRecords: CanonicalManifestLotRecord[]
  acceptedEvidenceIdentityKeys: string[]
  verifiedLotIdentityFingerprint: string
  acceptedHistoricalPriceFingerprint: string
  realizedPnlFingerprint: string
  scanFingerprint: string
  realizedPnlUsd: number | null
  verifiedLotCount: number
  structuralLotCount: number
  verifiedPricingCoverage: number | null
  createdAt: number
  refreshedAt: number
  refreshReason: string | null
}

type DeterminismFingerprints = {
  verifiedLotIdentityFingerprint: string
  acceptedHistoricalPriceFingerprint: string
  realizedPnlFingerprint: string
  scanFingerprint: string
}

// Loads the immutable accepted-evidence record backing one lot side. Supplied by the caller so this
// module stays free of KV wiring of its own and remains directly testable.
// `lotIdentityVersion: null` means DISCOVERY: return the record backing this tx side whatever
// lot-identity version it carries, so the manifest can record that version once at build time (see
// acceptedEvidenceStore's readAcceptedEvidenceAnyLotVersion for why partial fills need this). A
// non-null version means a STRICT read — every identity field including the version must match,
// which is what every replay uses.
export type AcceptedEvidenceLoader = (identity: {
  chain: string; token: string; txHash: string; side: AcceptedEvidenceSide; timestamp: number; lotIdentityVersion: string | null
}) => Promise<AcceptedEvidenceEnvelope | null>

function sideIdentityForLot(lot: MatchedLot, side: AcceptedEvidenceSide) {
  return {
    chain: lot.chain,
    token: lot.token,
    txHash: side === 'entry' ? lot.openedTxHash : lot.closedTxHash,
    side,
    timestamp: side === 'entry' ? lot.openedAt : lot.closedAt,
    lotIdentityVersion: lotIdentityVersion(lot),
  }
}

export async function buildManifestFromCandidate(params: {
  identity: CanonicalPnlSampleManifestIdentity
  // The FULL canonical lot array — required so partial-fill ordinals are assigned over every slice,
  // not just the priced ones (see buildCanonicalLotIdentities' own header).
  allCandidateLots: readonly MatchedLot[]
  candidateVerifiedLots: readonly MatchedLot[]
  structuralLotCount: number
  // FALLBACK ONLY, DISCLOSED: used verbatim only when `loadEvidence`/`computeFingerprints` are both
  // absent (legacy callers/tests with no evidence to allocate from). Otherwise recomputed from the
  // corrected, allocated lot values — see this function's own "REALIZED TOTAL / FINGERPRINTS" note.
  fingerprints: DeterminismFingerprints
  realizedPnlUsd: number | null
  verifiedPricingCoverage: number | null
  now: number
  priorManifest?: CanonicalPnlSampleManifest | null
  refreshReason?: string | null
  // Loads the accepted-evidence record backing one lot side — the source of truth for Part A's
  // per-sibling value allocation. A missing loader degrades to the legacy (no-allocation) path.
  loadEvidence?: AcceptedEvidenceLoader
  // Recomputes the four determinism fingerprints over a candidate array — required alongside
  // `loadEvidence` to get the corrected total/fingerprints; see this function's own note above.
  computeFingerprints?: (lots: readonly MatchedLot[], realizedPnlUsd: number | null) => DeterminismFingerprints
}): Promise<CanonicalPnlSampleManifest> {
  const identities = buildCanonicalLotIdentities(params.allCandidateLots)

  // GROUP BY SHARED EVIDENCE SIDE, DISCLOSED (Part A): populated from `allCandidateLots` — every
  // structurally-matched lot drawing from a transaction side, whether currently verified or not —
  // so a verified sibling is never over-credited a share that rightly belongs to an unpriced one.
  const entryGroups = new Map<string, MatchedLot[]>()
  const exitGroups = new Map<string, MatchedLot[]>()
  for (const lot of params.allCandidateLots) {
    const [entryKey, exitKey] = acceptedEvidenceIdentityKeysForLot(lot)
    entryGroups.set(entryKey, [...(entryGroups.get(entryKey) ?? []), lot])
    exitGroups.set(exitKey, [...(exitGroups.get(exitKey) ?? []), lot])
  }

  // Load each group's evidence ONCE (never once per sibling) and compute its allocation once.
  const entryEvidenceByKey = new Map<string, AcceptedEvidenceEnvelope | null>()
  const exitEvidenceByKey = new Map<string, AcceptedEvidenceEnvelope | null>()
  const entryAllocationByKey = new Map<string, Map<MatchedLot, SideAllocationShare>>()
  const exitAllocationByKey = new Map<string, Map<MatchedLot, SideAllocationShare>>()
  if (params.loadEvidence) {
    for (const [key, groupLots] of entryGroups) {
      // eslint-disable-next-line no-await-in-loop
      const evidence = await params.loadEvidence({ ...sideIdentityForLot(groupLots[0], 'entry'), lotIdentityVersion: null })
      entryEvidenceByKey.set(key, evidence)
      if (evidence) entryAllocationByKey.set(key, new Map(allocateSideValueAcrossGroup(groupLots, stablecoinNormalizedGroupTotal(groupLots, evidence.priceUsd)).map((s) => [s.lot, s])))
    }
    for (const [key, groupLots] of exitGroups) {
      // eslint-disable-next-line no-await-in-loop
      const evidence = await params.loadEvidence({ ...sideIdentityForLot(groupLots[0], 'exit'), lotIdentityVersion: null })
      exitEvidenceByKey.set(key, evidence)
      if (evidence) exitAllocationByKey.set(key, new Map(allocateSideValueAcrossGroup(groupLots, stablecoinNormalizedGroupTotal(groupLots, evidence.priceUsd)).map((s) => [s.lot, s])))
    }
  }

  // PER-LOT ALLOCATION FROM EVIDENCE (Part A, unchanged) — each verified lot's own proportional
  // share of its two shared transaction-side totals.
  type AllocatedLot = {
    lot: MatchedLot
    identity: CanonicalLotIdentity
    entryEvidenceKey: string
    exitEvidenceKey: string
    entryEvidence: AcceptedEvidenceEnvelope | null
    exitEvidence: AcceptedEvidenceEnvelope | null
    entryShare: SideAllocationShare | null
    exitShare: SideAllocationShare | null
    costBasisUsd: number | null
    proceedsUsd: number | null
  }
  const allocated: AllocatedLot[] = []
  for (const lot of params.candidateVerifiedLots) {
    const identity = identities.get(lot)
    if (!identity) continue
    const [entryEvidenceKey, exitEvidenceKey] = acceptedEvidenceIdentityKeysForLot(lot)
    const entryEvidence = entryEvidenceByKey.get(entryEvidenceKey) ?? null
    const exitEvidence = exitEvidenceByKey.get(exitEvidenceKey) ?? null
    const entryShare = entryAllocationByKey.get(entryEvidenceKey)?.get(lot) ?? null
    const exitShare = exitAllocationByKey.get(exitEvidenceKey)?.get(lot) ?? null
    // FALLS BACK TO THE LOT'S OWN VALUE ONLY when no evidence loader was supplied at all (legacy
    // callers/tests) or a group's evidence genuinely could not be loaded — never silently drops the
    // lot from the manifest; the build simply cannot correct what it has no evidence to correct.
    allocated.push({
      lot, identity, entryEvidenceKey, exitEvidenceKey, entryEvidence, exitEvidence, entryShare, exitShare,
      costBasisUsd: entryShare ? entryShare.allocatedValueUsd : lot.costBasisUsd,
      proceedsUsd: exitShare ? exitShare.allocatedValueUsd : lot.proceedsUsd,
    })
  }

  // COLLAPSE INTO OCCURRENCE GROUPS (requirement #1): identical lots produce ONE record carrying the
  // group's multiplicity and its summed totals.
  const byOccurrenceKey = new Map<string, AllocatedLot[]>()
  for (const entry of allocated) {
    const existing = byOccurrenceKey.get(entry.identity.key)
    if (existing) existing.push(entry)
    else byOccurrenceKey.set(entry.identity.key, [entry])
  }

  const records: CanonicalManifestLotRecord[] = []
  const rawEvidenceKeys: string[] = []
  // Maps each occurrence-group key to the exact per-occurrence values the manifest freezes, so the
  // corrected array below (and therefore the stored fingerprints) is built from the SAME
  // deterministic split replay will later reproduce — never from the raw per-lot allocation, whose
  // remainder placement depends on evidence-group ordering rather than on this group alone.
  const frozenSharesByKey = new Map<string, { cost: Array<number | null>; proceeds: Array<number | null>; pnl: Array<number | null> }>()

  for (const [key, members] of byOccurrenceKey) {
    const representative = members[0]
    const lot = representative.lot
    const occurrenceCount = members.length
    const sumOrNull = (values: Array<number | null>): number | null => {
      if (values.some((v) => v === null)) return null
      let sum = 0
      for (const v of values) sum += v as number
      return Math.round(sum * 1e8) / 1e8
    }
    const groupCostBasisUsd = sumOrNull(members.map((m) => m.costBasisUsd))
    const groupProceedsUsd = sumOrNull(members.map((m) => m.proceedsUsd))

    // DETERMINISTIC RE-SPLIT, DISCLOSED: the group's total is immediately re-split across its own
    // occurrences with `splitGroupTotalAcrossOccurrences` — the exact function replay uses. This is
    // what makes build and replay produce a bit-for-bit identical multiset of per-lot values, and
    // therefore identical fingerprints, without either side consulting array order.
    const costShares = splitGroupTotalAcrossOccurrences(groupCostBasisUsd, occurrenceCount)
    const proceedsShares = splitGroupTotalAcrossOccurrences(groupProceedsUsd, occurrenceCount)
    const pnlShares = costShares.map((c, i) => {
      const p = proceedsShares[i]
      return c === null || p === null ? null : Math.round((p - c) * 100) / 100
    })
    frozenSharesByKey.set(key, { cost: costShares, proceeds: proceedsShares, pnl: pnlShares })
    const groupRealizedPnlUsd = sumOrNull(pnlShares)

    records.push({
      key,
      canonicalAmount: representative.identity.canonicalAmount,
      occurrenceCount,
      partialFillGroupSize: representative.identity.partialFillGroupSize,
      groupCostBasisUsd,
      groupProceedsUsd,
      groupRealizedPnlUsd,
      chain: lot.chain,
      token: lot.token,
      openedTxHash: lot.openedTxHash,
      closedTxHash: lot.closedTxHash,
      openedAt: lot.openedAt,
      closedAt: lot.closedAt,
      lotIdentityVersion: lotIdentityVersion(lot),
      entryEvidenceKey: representative.entryEvidenceKey,
      exitEvidenceKey: representative.exitEvidenceKey,
      entryEvidenceLotIdentityVersion: representative.entryEvidence?.lotIdentityVersion ?? null,
      exitEvidenceLotIdentityVersion: representative.exitEvidence?.lotIdentityVersion ?? null,
      // Per-OCCURRENCE frozen values (the first occurrence's share) — validation metadata only; the
      // group totals above are the authoritative figures replay validates against.
      entryPriceUsd: costShares[0] ?? null,
      entryValueUsd: representative.entryEvidence?.valueUsd ?? null,
      exitPriceUsd: proceedsShares[0] ?? null,
      exitValueUsd: representative.exitEvidence?.valueUsd ?? null,
      costBasisUsd: costShares[0] ?? null,
      proceedsUsd: proceedsShares[0] ?? null,
      realizedPnlUsd: pnlShares[0] ?? null,
      evidenceQuality: lot.evidenceQuality,
      entrySource: representative.entryEvidence?.source ?? null,
      exitSource: representative.exitEvidence?.source ?? null,
      pricingMethodologyVersion: params.identity.pricingMethodologyVersion,
      evidenceSchemaVersion: representative.entryEvidence?.schemaVersion ?? null,
      acceptedEvidenceValueType: 'total_side_value_usd',
      entrySideGroupIdentity: representative.entryEvidenceKey,
      entrySideGroupRawQuantity: representative.entryShare?.denominator ?? '0',
      entryLotRawQuantity: representative.entryShare?.numerator ?? '0',
      entryAllocationNumerator: representative.entryShare?.numerator ?? '0',
      entryAllocationDenominator: representative.entryShare?.denominator ?? '0',
      exitSideGroupIdentity: representative.exitEvidenceKey,
      exitSideGroupRawQuantity: representative.exitShare?.denominator ?? '0',
      exitLotRawQuantity: representative.exitShare?.numerator ?? '0',
      exitAllocationNumerator: representative.exitShare?.numerator ?? '0',
      exitAllocationDenominator: representative.exitShare?.denominator ?? '0',
      allocatedCostBasisUsd: groupCostBasisUsd,
      allocatedProceedsUsd: groupProceedsUsd,
    })
    for (const m of members) rawEvidenceKeys.push(m.entryEvidenceKey, m.exitEvidenceKey)
  }

  // CANONICALIZE -> SORT -> DEDUPE before persistence (requirement #2 of the prior task).
  const { unique: verifiedLotIdentityKeys } = dedupeKeys(records.map((r) => r.key))
  const { unique: acceptedEvidenceIdentityKeys } = dedupeKeys(rawEvidenceKeys)
  const dedupedRecords = verifiedLotIdentityKeys
    .map((key) => records.find((r) => r.key === key))
    .filter((r): r is CanonicalManifestLotRecord => r !== undefined)
  // THE REAL PUBLISHED LOT COUNT, DISCLOSED: the SUM of every group's multiplicity — never the
  // number of records, which now counts GROUPS rather than lots.
  const verifiedLotCountFromGroups = dedupedRecords.reduce((sum, r) => sum + r.occurrenceCount, 0)

  // Per-lot corrected values, drawn from the same frozen per-occurrence shares stored above.
  const correctedByLot = new Map<MatchedLot, MatchedLot>()
  for (const [key, members] of byOccurrenceKey) {
    const shares = frozenSharesByKey.get(key)!
    members.forEach((m, i) => {
      correctedByLot.set(m.lot, { ...m.lot, costBasisUsd: shares.cost[i], proceedsUsd: shares.proceeds[i], realizedPnlUsd: shares.pnl[i] })
    })
  }

  // REALIZED TOTAL / FINGERPRINTS, DISCLOSED (Part A): when evidence was actually loaded and
  // allocation applied, the manifest's own frozen total and fingerprints are computed from the
  // CORRECTED (allocated) per-lot values via `computeFingerprints` — never trusted blindly off the
  // caller's pre-computed `params.realizedPnlUsd`/`params.fingerprints`, which may still reflect the
  // pre-allocation (buggy, flat-copy) values on a caller that hasn't re-derived them itself. Falls
  // back to the caller-supplied values only when no evidence loader was given at all.
  let realizedPnlUsd = params.realizedPnlUsd
  let fingerprints = params.fingerprints
  if (params.loadEvidence && params.computeFingerprints) {
    const correctedAllLots = params.allCandidateLots.map((lot) => correctedByLot.get(lot) ?? lot)
    const correctedVerified = correctedAllLots.filter(isCanonicalVerifiedPublishedLot)
    realizedPnlUsd = correctedVerified.length > 0
      ? sumQuantizedUsd(sortLotsByCanonicalIdentity(correctedVerified).map((l) => l.realizedPnlUsd))
      : null
    fingerprints = params.computeFingerprints(correctedAllLots, realizedPnlUsd)
  }

  return {
    ...params.identity,
    lotIdentitySchemaVersion: CANONICAL_LOT_IDENTITY_SCHEMA_VERSION,
    manifestVersion: params.priorManifest ? params.priorManifest.manifestVersion + 1 : 1,
    priorManifestVersion: params.priorManifest ? params.priorManifest.manifestVersion : null,
    verifiedLotIdentityKeys,
    verifiedLotRecords: dedupedRecords,
    acceptedEvidenceIdentityKeys,
    verifiedLotIdentityFingerprint: fingerprints.verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint: fingerprints.acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint: fingerprints.realizedPnlFingerprint,
    scanFingerprint: fingerprints.scanFingerprint,
    realizedPnlUsd,
    // The REAL published count — deduplicated, so it can never be inflated by a duplicate key.
    verifiedLotCount: verifiedLotCountFromGroups,
    structuralLotCount: params.structuralLotCount,
    verifiedPricingCoverage: params.verifiedPricingCoverage,
    createdAt: params.priorManifest ? params.priorManifest.createdAt : params.now,
    refreshedAt: params.now,
    refreshReason: params.priorManifest ? (params.refreshReason ?? null) : null,
  }
}

export async function buildRefreshedManifest(params: {
  priorManifest: CanonicalPnlSampleManifest
  identity: CanonicalPnlSampleManifestIdentity
  allCandidateLots: readonly MatchedLot[]
  candidateVerifiedLots: readonly MatchedLot[]
  structuralLotCount: number
  fingerprints: DeterminismFingerprints
  realizedPnlUsd: number | null
  verifiedPricingCoverage: number | null
  now: number
  refreshReason: string
  loadEvidence?: AcceptedEvidenceLoader
  computeFingerprints?: (lots: readonly MatchedLot[], realizedPnlUsd: number | null) => DeterminismFingerprints
}): Promise<CanonicalPnlSampleManifest> {
  return buildManifestFromCandidate({ ...params, priorManifest: params.priorManifest })
}

// VALIDATION, DISCLOSED, FAIL-CLOSED: any identity-field mismatch or structurally-corrupt record
// makes the manifest unusable — same posture as acceptedEvidenceStore's own isValidAcceptedEvidence.
// Never throws.
export function isValidCanonicalPnlSampleManifest(raw: unknown, expectedIdentity: CanonicalPnlSampleManifestIdentity): raw is CanonicalPnlSampleManifest {
  if (raw === null || typeof raw !== 'object') return false
  const m = raw as Partial<CanonicalPnlSampleManifest>
  if (m.normalizedWalletAddress !== expectedIdentity.normalizedWalletAddress) return false
  if (m.chainScope !== expectedIdentity.chainScope) return false
  if (m.scanWindowIdentity !== expectedIdentity.scanWindowIdentity) return false
  if (m.matchedLotFingerprint !== expectedIdentity.matchedLotFingerprint) return false
  if (m.pricingMethodologyVersion !== expectedIdentity.pricingMethodologyVersion) return false
  if (m.valueMethodologyVersion !== expectedIdentity.valueMethodologyVersion) return false
  if (m.manifestSchemaVersion !== expectedIdentity.manifestSchemaVersion) return false
  if (m.lotIdentitySchemaVersion !== CANONICAL_LOT_IDENTITY_SCHEMA_VERSION) return false
  if (!Array.isArray(m.verifiedLotIdentityKeys)) return false
  if (!Array.isArray(m.verifiedLotRecords)) return false
  if (!Array.isArray(m.acceptedEvidenceIdentityKeys)) return false
  if (typeof m.verifiedLotIdentityFingerprint !== 'string') return false
  if (typeof m.acceptedHistoricalPriceFingerprint !== 'string') return false
  if (typeof m.realizedPnlFingerprint !== 'string') return false
  if (typeof m.scanFingerprint !== 'string') return false
  if (typeof m.manifestVersion !== 'number') return false
  if (typeof m.verifiedLotCount !== 'number') return false
  if (typeof m.structuralLotCount !== 'number') return false
  if (typeof m.createdAt !== 'number') return false
  if (typeof m.refreshedAt !== 'number') return false
  return true
}

export type ReadCanonicalPnlSampleManifestResult = {
  manifest: CanonicalPnlSampleManifest | null
  validationFailure: boolean
}

export async function readCanonicalPnlSampleManifest(
  kv: CanonicalSampleManifestKvLike,
  identity: CanonicalPnlSampleManifestIdentity,
): Promise<ReadCanonicalPnlSampleManifestResult> {
  try {
    const raw = await kv.get<unknown>(buildManifestKey(identity))
    if (raw === null || raw === undefined) return { manifest: null, validationFailure: false }
    if (!isValidCanonicalPnlSampleManifest(raw, identity)) return { manifest: null, validationFailure: true }
    return { manifest: raw, validationFailure: false }
  } catch {
    // I/O failure fails OPEN to "no manifest" (matching acceptedEvidenceStore's own read posture) —
    // never fabricated as a validation failure, which would misreport a transient outage as data
    // corruption in the audit.
    return { manifest: null, validationFailure: false }
  }
}

export async function writeCanonicalPnlSampleManifest(kv: CanonicalSampleManifestKvLike, manifest: CanonicalPnlSampleManifest): Promise<boolean> {
  try {
    await kv.set(buildManifestKey(manifest), manifest)
    return true
  } catch {
    return false
  }
}

// ============================================================================
// REPLAY (requirements #3, #4, #6, #7)
// ============================================================================

export type ManifestReplayReason =
  | 'manifest_lot_identity_not_found'
  | 'manifest_side_evidence_missing'
  | 'manifest_side_evidence_invalid'
  | 'manifest_partial_fill_ordinal_mismatch'
  | 'manifest_duplicate_identity'
  | 'manifest_candidate_only_lot'
  | 'manifest_replay_success'
  // VALUE-REPLAY REASONS, DISCLOSED (requirement #3): the confirmed production failure was
  // exclusively in this class — identity replay reported 23/23 success while the canonical VALUES
  // silently drifted, so every value comparison now has its own named, counted failure mode.
  | 'manifest_entry_price_mismatch'
  | 'manifest_exit_price_mismatch'
  | 'manifest_cost_basis_mismatch'
  | 'manifest_proceeds_mismatch'
  | 'manifest_realized_pnl_mismatch'
  | 'manifest_evidence_quality_mismatch'
  | 'manifest_realized_total_mismatch'
  | 'manifest_fingerprint_mismatch'

export type ManifestReplayReasonCounts = Record<ManifestReplayReason, number>

function emptyReplayReasonCounts(): ManifestReplayReasonCounts {
  return {
    manifest_lot_identity_not_found: 0,
    manifest_side_evidence_missing: 0,
    manifest_side_evidence_invalid: 0,
    manifest_partial_fill_ordinal_mismatch: 0,
    manifest_duplicate_identity: 0,
    manifest_candidate_only_lot: 0,
    manifest_replay_success: 0,
    manifest_entry_price_mismatch: 0,
    manifest_exit_price_mismatch: 0,
    manifest_cost_basis_mismatch: 0,
    manifest_proceeds_mismatch: 0,
    manifest_realized_pnl_mismatch: 0,
    manifest_evidence_quality_mismatch: 0,
    manifest_realized_total_mismatch: 0,
    manifest_fingerprint_mismatch: 0,
  }
}

export type ManifestReplayResult = {
  outcome: 'applied' | 'unavailable'
  // The ONE canonical array every downstream consumer publishes from (requirement #5/#10). Always
  // the same length and the same structural lots as the input array — this function never adds,
  // removes or reorders a lot, it only decides which verified lots are PUBLISHED. A lot that is not
  // published is returned in the honest `'unpriced'` state rather than being deleted, so structural
  // coverage denominators and FIFO's own matched-lot set are completely unaffected.
  publishedLots: MatchedLot[]
  // Set when the manifest could not be replayed in full — the caller must publish a degraded/
  // unavailable public result, never the live candidate sample (requirement #4).
  forcePublicPnlUnavailable: boolean
  selectedLotKeys: string[]
  candidateNewEvidenceLotKeys: string[]
  manifestLotsMissingCurrentEvidence: string[]
  reasonCounts: ManifestReplayReasonCounts
  duplicates: DuplicateIdentityCheck
  // REQUIREMENT #4/#5: the frozen total re-derived by SUMMING the reconstructed published lots —
  // never copied from `manifest.realizedPnlUsd`. Null when replay failed.
  recomputedRealizedPnlUsd: number | null
  recomputedFingerprints: DeterminismFingerprints | null
  // REQUIREMENT #7: manifest lots that replayed their identity+evidence successfully but still fail
  // the ONE canonical published-verified predicate. After a successful replay this MUST be empty.
  manifestReplayedButNotCanonicalVerifiedLotKeys: string[]
  // FINGERPRINT-MISMATCH DIAGNOSTIC, DISCLOSED, ADDITIVE (fingerprint-mismatch audit task): null
  // whenever every per-lot/per-value check above already passed AND every fingerprint agreed — set
  // ONLY on the specific, confirmed-production shape of a replay that resolves every manifest lot,
  // passes every per-group value/total check, yet still fails on `manifest_fingerprint_mismatch`
  // alone. See buildFingerprintMismatchDiagnostic's own header for what it isolates.
  fingerprintMismatchDiagnostic: FingerprintMismatchDiagnostic | null
  // STALE-MANIFEST CANONICALIZATION MISMATCH, DISCLOSED, ADDITIVE (stale-manifest self-heal
  // follow-up task — confirmed production shape: a manifest written BEFORE 66adf73c's
  // create/replay canonicalization fix carries a raw, pre-allocation realizedPnlUsd/fingerprints;
  // every later replay correctly recomputes the corrected, cent-rounded figures and therefore
  // permanently mismatches its own manifest, even though every per-lot check — identity, side
  // evidence, cost/proceeds tolerance, chronology — genuinely passed). True only when EVERY per-lot
  // check passed (`!perLotFailed`: no identity mismatch, no missing/invalid side evidence, no
  // cost/proceeds/chronology failure) AND the stored `verifiedLotIdentityFingerprint` itself still
  // matches (the lot SET is identical) AND the only disagreement is in the derived USD fingerprints
  // (`acceptedHistoricalPriceFingerprint`/`realizedPnlFingerprint`) — never set on a genuine identity
  // divergence, missing evidence, or a real cost/proceeds/value mismatch. The caller (pipeline) uses
  // this, and ONLY this, to decide whether a one-time manifest refresh is safe.
  staleManifestCanonicalizationMismatch: boolean
}

// FINGERPRINT-MISMATCH DIAGNOSTIC, DISCLOSED (fingerprint-mismatch audit task — confirmed production
// shape: manifest replay resolves 23/23 lots, zero lot/value/identity/evidence mismatches, yet
// `manifest_fingerprint_mismatch` still fires and forces `manifestApplied: false`/
// `canonicalSampleEvidenceUnavailable: true`).
//
// ROOT MECHANISM THIS ISOLATES, DISCLOSED: the manifest's STORED fingerprints
// (verifiedLotIdentityFingerprint/acceptedHistoricalPriceFingerprint/realizedPnlFingerprint) were
// computed ONCE, at build time, from `reconciledLots` — i.e. from pnlReconciliation's own
// `hydrateFromAcceptedEvidence` per-lot allocation of the accepted-evidence side totals. The
// RECOMPUTED fingerprints on replay are instead computed from `candidatePublished` — i.e. from THIS
// module's own, SEPARATE per-lot allocation (`allocateSideValueAcrossGroup` /
// `splitGroupTotalAcrossOccurrences`, re-run independently inside `buildManifestFromCandidate`/
// `replayManifest` from the same stored evidence). Both allocations read the identical accepted-
// evidence totals and both are individually correct — the per-lot/per-group VALUE checks above
// already prove they agree within `CANONICAL_VALUE_TOLERANCE` — but they are two independently
// re-derived numbers, not one shared computation, so they are not always BIT-IDENTICAL, and the
// fingerprint comparison is an EXACT string-equality check with no tolerance. This diagnostic makes
// that gap directly observable: it compares each replayed lot's THIS-SCAN, PRE-REBUILD live value
// (`occurrences[i]` — exactly what fed the STORED fingerprint at build time, since that scan's own
// `reconciledLots` carried the same hydrate-time allocation) against the SAME lot's REBUILT value
// (`rebuiltByLot` — exactly what feeds the RECOMPUTED fingerprint this replay). A non-zero, sub-cent
// divergence for one or more lots there is direct proof of two independent allocations disagreeing
// at float precision; an EMPTY list with the fingerprints still disagreeing instead points at the
// realized-PnL SUM (order-dependent floating-point addition over `publishedVerified`/
// `candidateVerifiedLots`, see `realizedPnlFingerprint`'s own header) rather than any per-lot value.
export type FingerprintMismatchDiagnostic = {
  verifiedLotIdentityFingerprintMismatch: boolean
  acceptedHistoricalPriceFingerprintMismatch: boolean
  realizedPnlFingerprintMismatch: boolean
  storedRealizedPnlUsd: number | null
  recomputedRealizedPnlUsd: number | null
  storedRealizedPnlFingerprint: string
  recomputedRealizedPnlFingerprint: string
  storedVerifiedLotIdentityFingerprint: string
  recomputedVerifiedLotIdentityFingerprint: string
  storedAcceptedHistoricalPriceFingerprint: string
  recomputedAcceptedHistoricalPriceFingerprint: string
  replayedLotCount: number
  // Every replayed lot whose THIS-SCAN pre-rebuild value (what fed the STORED fingerprint) differs
  // AT ALL from its rebuilt value (what feeds the RECOMPUTED fingerprint) — sorted by the largest
  // single-field absolute difference, descending, bounded to the top 10 (never per-lot-unbounded
  // logging — this codebase's own prior confirmed stdout-backpressure bug).
  divergentLotCount: number
  topDivergentLots: Array<{
    groupKey: string
    livePreRebuildCostBasisUsd: number | null
    rebuiltCostBasisUsd: number | null
    livePreRebuildProceedsUsd: number | null
    rebuiltProceedsUsd: number | null
    livePreRebuildRealizedPnlUsd: number | null
    rebuiltRealizedPnlUsd: number | null
    maxAbsDifferenceUsd: number
  }>
}

const FINGERPRINT_MISMATCH_TOP_DIVERGENT_LOTS = 10

function absDiff(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : Number.POSITIVE_INFINITY
  return Math.abs(a - b)
}

export function buildFingerprintMismatchDiagnostic(params: {
  manifest: CanonicalPnlSampleManifest
  recomputedFingerprints: DeterminismFingerprints
  recomputedRealizedPnlUsd: number | null
  // Original (this-scan, pre-rebuild) lot -> its rebuilt replacement, for every replayed lot —
  // exactly `rebuiltByLot` from replayManifest's own atomic replay loop.
  rebuiltByLot: ReadonlyMap<MatchedLot, MatchedLot>
  identities: ReadonlyMap<MatchedLot, CanonicalLotIdentity>
}): FingerprintMismatchDiagnostic {
  const rows: FingerprintMismatchDiagnostic['topDivergentLots'] = []
  for (const [live, rebuilt] of params.rebuiltByLot) {
    const costDiff = absDiff(live.costBasisUsd, rebuilt.costBasisUsd)
    const proceedsDiff = absDiff(live.proceedsUsd, rebuilt.proceedsUsd)
    const pnlDiff = absDiff(live.realizedPnlUsd, rebuilt.realizedPnlUsd)
    const maxAbsDifferenceUsd = Math.max(costDiff, proceedsDiff, pnlDiff)
    if (maxAbsDifferenceUsd === 0) continue
    rows.push({
      groupKey: params.identities.get(live)?.key ?? 'unknown',
      livePreRebuildCostBasisUsd: live.costBasisUsd,
      rebuiltCostBasisUsd: rebuilt.costBasisUsd,
      livePreRebuildProceedsUsd: live.proceedsUsd,
      rebuiltProceedsUsd: rebuilt.proceedsUsd,
      livePreRebuildRealizedPnlUsd: live.realizedPnlUsd,
      rebuiltRealizedPnlUsd: rebuilt.realizedPnlUsd,
      maxAbsDifferenceUsd,
    })
  }
  rows.sort((a, b) => b.maxAbsDifferenceUsd - a.maxAbsDifferenceUsd)
  return {
    verifiedLotIdentityFingerprintMismatch: params.recomputedFingerprints.verifiedLotIdentityFingerprint !== params.manifest.verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprintMismatch: params.recomputedFingerprints.acceptedHistoricalPriceFingerprint !== params.manifest.acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprintMismatch: params.recomputedFingerprints.realizedPnlFingerprint !== params.manifest.realizedPnlFingerprint,
    storedRealizedPnlUsd: params.manifest.realizedPnlUsd,
    recomputedRealizedPnlUsd: params.recomputedRealizedPnlUsd,
    storedRealizedPnlFingerprint: params.manifest.realizedPnlFingerprint,
    recomputedRealizedPnlFingerprint: params.recomputedFingerprints.realizedPnlFingerprint,
    storedVerifiedLotIdentityFingerprint: params.manifest.verifiedLotIdentityFingerprint,
    recomputedVerifiedLotIdentityFingerprint: params.recomputedFingerprints.verifiedLotIdentityFingerprint,
    storedAcceptedHistoricalPriceFingerprint: params.manifest.acceptedHistoricalPriceFingerprint,
    recomputedAcceptedHistoricalPriceFingerprint: params.recomputedFingerprints.acceptedHistoricalPriceFingerprint,
    replayedLotCount: params.rebuiltByLot.size,
    divergentLotCount: rows.length,
    topDivergentLots: rows.slice(0, FINGERPRINT_MISMATCH_TOP_DIVERGENT_LOTS),
  }
}

export function logFingerprintMismatchDiagnosticIfAny(
  diagnostic: FingerprintMismatchDiagnostic | null,
  logger: Pick<Console, 'warn'> = console,
): void {
  if (!diagnostic) return
  logger.warn('[fingerprint-mismatch-diagnostic]', diagnostic)
}

// Reverts a lot to the honest unpriced state for PUBLICATION purposes only. Never mutates the input
// (returns a new object), never changes chain/token/tx/timestamp/amount — FIFO matching,
// classification and the structural lot set are all completely untouched (this task's own explicit
// "do not change FIFO, pricing values, gates, classifications" constraint). The lot's real live
// price still exists upstream; it is simply not published as canonical this scan.
function withheldFromPublication(lot: MatchedLot): MatchedLot {
  if (lot.evidenceQuality !== 'verified' && lot.costBasisUsd === null && lot.proceedsUsd === null) return lot
  return { ...lot, evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }
}

// ATOMIC REPLAY, DISCLOSED (requirement #3): every list below is computed in full BEFORE any
// published array is constructed, and the published array is built exactly once, from a single
// decision. There is no incremental mutation of a shared lot array anywhere in this function — the
// prior implementation's mutate-then-decide shape is exactly what let a live 23-lot sample escape
// while the audit simultaneously reported the manifest as unavailable.
export async function replayManifest(params: {
  manifest: CanonicalPnlSampleManifest
  allCandidateLots: readonly MatchedLot[]
  // REQUIRED (requirement #2): accepted evidence is the SOURCE OF TRUTH for every manifest lot's
  // canonical values. Without a loader nothing can be verified, so every lot fails closed rather
  // than falling back to the manifest's own stored numbers (requirement #1's explicit "stored
  // numeric values ... must never silently override missing/invalid accepted evidence").
  loadEvidence: AcceptedEvidenceLoader
  // BOUNDED-CONCURRENCY BATCH LOAD, DISCLOSED (Part C — confirmed perf issue: sequential per-side
  // awaits, one per lot, were a real, measurable chunk of a 77s scan). Optional: when omitted, one
  // is built automatically from `loadEvidence` with bounded concurrency, so every caller gets the
  // speedup with zero wiring required.
  loadEvidenceBatch?: (requests: readonly { key: string; identity: Parameters<AcceptedEvidenceLoader>[0] }[]) => Promise<Map<string, Awaited<ReturnType<AcceptedEvidenceLoader>>>>
  // Recomputes the determinism fingerprints over a candidate published array, so replay can prove
  // the frozen result is internally derivable (requirement #4) rather than merely asserted.
  computeFingerprints: (lots: readonly MatchedLot[], realizedPnlUsd: number | null) => DeterminismFingerprints
}): Promise<ManifestReplayResult> {
  const reasonCounts = emptyReplayReasonCounts()

  // 1. Build the current candidate identity map over the FULL array (ordinals must see every slice).
  const identities = buildCanonicalLotIdentities(params.allCandidateLots)
  const candidateVerifiedLots = params.allCandidateLots.filter(isCanonicalVerifiedPublishedLot)

  // GROUP BY SHARED EVIDENCE SIDE (Part A, replay side) — same population rule as build time:
  // every structurally-matched lot from `allCandidateLots`, verified or not.
  const entryGroupsByKey = new Map<string, MatchedLot[]>()
  const exitGroupsByKey = new Map<string, MatchedLot[]>()
  for (const lot of params.allCandidateLots) {
    const [entryKey, exitKey] = acceptedEvidenceIdentityKeysForLot(lot)
    entryGroupsByKey.set(entryKey, [...(entryGroupsByKey.get(entryKey) ?? []), lot])
    exitGroupsByKey.set(exitKey, [...(exitGroupsByKey.get(exitKey) ?? []), lot])
  }

  // 2. Canonicalize + dedupe both sides (requirement #2).
  const manifestDedupe = dedupeKeys(params.manifest.verifiedLotIdentityKeys)
  // GROUPED MULTIPLICITY, DISCLOSED: an occurrence-group key legitimately maps to MANY identical
  // lots now, so collecting one key per lot would report every genuine duplicate-lot group as a
  // duplicate-IDENTITY corruption. The candidate side is therefore deduped over the DISTINCT group
  // keys this scan produced — real corruption (the same key emitted twice by
  // buildCanonicalLotIdentities' own grouping) remains impossible by construction, and a corrupt
  // MANIFEST carrying a repeated key is still caught by `manifestDedupe` above, unchanged.
  const candidateDedupe = dedupeKeys([...new Set(candidateVerifiedLots.map((lot) => identities.get(lot)?.key ?? '').filter((k) => k !== ''))])
  const evidenceDedupe = dedupeKeys(params.manifest.acceptedEvidenceIdentityKeys)
  const duplicates: DuplicateIdentityCheck = {
    hasDuplicates: manifestDedupe.duplicates.length > 0 || candidateDedupe.duplicates.length > 0 || evidenceDedupe.duplicates.length > 0,
    manifestDuplicateLotKeys: manifestDedupe.duplicates,
    candidateDuplicateLotKeys: candidateDedupe.duplicates,
    manifestDuplicateEvidenceKeys: evidenceDedupe.duplicates,
  }
  reasonCounts.manifest_duplicate_identity = manifestDedupe.duplicates.length + candidateDedupe.duplicates.length + evidenceDedupe.duplicates.length

  // OCCURRENCE GROUPS FOR THIS SCAN (grouped-multiplicity rewrite): every lot sharing an
  // occurrence-group key, collected in full — replay matches the COMPLETE group by count, never one
  // representative by array position.
  const candidateOccurrenceGroups = new Map<string, MatchedLot[]>()
  for (const lot of params.allCandidateLots) {
    const identity = identities.get(lot)
    if (!identity) continue
    const existing = candidateOccurrenceGroups.get(identity.key)
    if (existing) existing.push(lot)
    else candidateOccurrenceGroups.set(identity.key, [lot])
  }
  const recordByKey = new Map(params.manifest.verifiedLotRecords.map((r) => [r.key, r]))

  // 2b. BATCH-LOAD every unique evidence side this manifest's records reference (Part C) — one
  // dedicated pass, bounded concurrency, before any per-lot validation runs. `defaultBatchLoad`
  // is used whenever the caller hasn't supplied its own `loadEvidenceBatch`.
  type EvidenceRequest = { key: string; identity: Parameters<AcceptedEvidenceLoader>[0] }
  const evidenceRequests = new Map<string, EvidenceRequest>()
  for (const key of manifestDedupe.unique) {
    const record = recordByKey.get(key)
    if (!record) continue
    evidenceRequests.set(record.entryEvidenceKey, {
      key: record.entryEvidenceKey,
      identity: { chain: record.chain, token: record.token, txHash: record.openedTxHash, side: 'entry', timestamp: record.openedAt, lotIdentityVersion: record.entryEvidenceLotIdentityVersion ?? record.lotIdentityVersion },
    })
    evidenceRequests.set(record.exitEvidenceKey, {
      key: record.exitEvidenceKey,
      identity: { chain: record.chain, token: record.token, txHash: record.closedTxHash, side: 'exit', timestamp: record.closedAt, lotIdentityVersion: record.exitEvidenceLotIdentityVersion ?? record.lotIdentityVersion },
    })
  }
  const defaultBatchLoad = async (requests: readonly EvidenceRequest[]) => {
    const map = new Map<string, Awaited<ReturnType<AcceptedEvidenceLoader>>>()
    const BATCH_CONCURRENCY = 8
    let cursor = 0
    async function worker(): Promise<void> {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= requests.length) return
        const req = requests[index]
        // eslint-disable-next-line no-await-in-loop
        const result = await params.loadEvidence(req.identity)
        map.set(req.key, result)
      }
    }
    const workerCount = Math.max(1, Math.min(BATCH_CONCURRENCY, requests.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return map
  }
  const evidenceRequestList = [...evidenceRequests.values()]
  const batchLoad = params.loadEvidenceBatch ?? defaultBatchLoad
  const evidenceByKey = evidenceRequestList.length ? await batchLoad(evidenceRequestList) : new Map<string, Awaited<ReturnType<AcceptedEvidenceLoader>>>()

  // 2c. Allocate each evidence group's total across its structural siblings ONCE (Part A), reusing
  // this scan's own structural lots (not the manifest's — the manifest carries no full lot objects).
  const entryAllocationByKey = new Map<string, Map<MatchedLot, SideAllocationShare>>()
  const exitAllocationByKey = new Map<string, Map<MatchedLot, SideAllocationShare>>()
  for (const [key, evidence] of evidenceByKey) {
    if (!evidence) continue
    const entryGroup = entryGroupsByKey.get(key)
    if (entryGroup) entryAllocationByKey.set(key, new Map(allocateSideValueAcrossGroup(entryGroup, stablecoinNormalizedGroupTotal(entryGroup, evidence.priceUsd)).map((share) => [share.lot, share])))
    const exitGroup = exitGroupsByKey.get(key)
    if (exitGroup) exitAllocationByKey.set(key, new Map(allocateSideValueAcrossGroup(exitGroup, stablecoinNormalizedGroupTotal(exitGroup, evidence.priceUsd)).map((share) => [share.lot, share])))
  }

  // 3. Resolve, REBUILD FROM ACCEPTED EVIDENCE (Part A: per-sibling allocated share, never a flat
  //    copy), and validate EVERY manifest lot (requirement #2/#3). Nothing is published until this
  //    loop completes — the rebuilt lots are collected in a local map and only merged into a
  //    published array in step 6, atomically.
  const rebuiltByLot = new Map<MatchedLot, MatchedLot>()
  const selectedLotKeys: string[] = []
  const manifestLotsMissingCurrentEvidence: string[] = []
  const manifestReplayedButNotCanonicalVerifiedLotKeys: string[] = []

  for (const key of manifestDedupe.unique) {
    const occurrences = candidateOccurrenceGroups.get(key)
    if (!occurrences || occurrences.length === 0) {
      reasonCounts.manifest_lot_identity_not_found += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    const structuralLot = occurrences[0]
    const currentIdentity = identities.get(structuralLot)
    const record = recordByKey.get(key)
    if (!record) {
      // A manifest that names a group but carries no canonical record for it cannot be value-replayed.
      reasonCounts.manifest_side_evidence_invalid += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    // GROUP MULTIPLICITY CHECK, DISCLOSED (requirement #1's "fail only when current group count or
    // totals differ"): the ONLY structural condition that can invalidate an occurrence group is a
    // change in how many identical lots it contains. Array order is never consulted — which is
    // precisely what the old positional-ordinal identity could not say.
    if (occurrences.length !== record.occurrenceCount) {
      reasonCounts.manifest_partial_fill_ordinal_mismatch += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    if (currentIdentity && record.canonicalAmount !== currentIdentity.canonicalAmount) {
      reasonCounts.manifest_side_evidence_invalid += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }

    // 3a. Look up the already-batch-loaded accepted-evidence records this group's values came from
    //     (Part C — no per-lot await here). These are the source of truth; the current scan's own
    //     provider values are diagnostic candidates only and are discarded below.
    const entryEvidence = evidenceByKey.get(record.entryEvidenceKey) ?? null
    const exitEvidence = evidenceByKey.get(record.exitEvidenceKey) ?? null
    if (!entryEvidence || !exitEvidence) {
      // readAcceptedEvidence already enforces exact identity/side/timestamp/lot-identity-version/
      // schemaVersion matching and expiry, so a null here means the record is genuinely absent or
      // genuinely fails that validation. Never substitute the manifest's stored number.
      reasonCounts.manifest_side_evidence_missing += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    if (record.pricingMethodologyVersion !== params.manifest.pricingMethodologyVersion) {
      reasonCounts.manifest_side_evidence_invalid += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }

    // 3b. Recompute this group's TOTALS from live accepted evidence (Part A allocation, unchanged),
    //     then validate those totals against the manifest's frozen group totals.
    const entryShares = occurrences.map((lot) => entryAllocationByKey.get(record.entryEvidenceKey)?.get(lot) ?? null)
    const exitShares = occurrences.map((lot) => exitAllocationByKey.get(record.exitEvidenceKey)?.get(lot) ?? null)
    if (entryShares.some((sh) => sh === null) || exitShares.some((sh) => sh === null)) {
      // Evidence loaded, but at least one occurrence isn't a member of the evidence group the
      // allocation was computed over — fail closed rather than publish an unallocated share.
      reasonCounts.manifest_side_evidence_invalid += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    const liveGroupCostBasisUsd = Math.round(entryShares.reduce((sum, sh) => sum + sh!.allocatedValueUsd, 0) * 1e8) / 1e8
    const liveGroupProceedsUsd = Math.round(exitShares.reduce((sum, sh) => sum + sh!.allocatedValueUsd, 0) * 1e8) / 1e8

    let mismatched = false
    if (!withinTolerance(liveGroupCostBasisUsd, record.groupCostBasisUsd, CANONICAL_VALUE_TOLERANCE)) { reasonCounts.manifest_entry_price_mismatch += 1; reasonCounts.manifest_cost_basis_mismatch += 1; mismatched = true }
    if (!withinTolerance(liveGroupProceedsUsd, record.groupProceedsUsd, CANONICAL_VALUE_TOLERANCE)) { reasonCounts.manifest_exit_price_mismatch += 1; reasonCounts.manifest_proceeds_mismatch += 1; mismatched = true }
    if (record.evidenceQuality !== 'verified') { reasonCounts.manifest_evidence_quality_mismatch += 1; mismatched = true }
    if (mismatched) {
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }

    // 3c. DETERMINISTICALLY RECONSTRUCT every occurrence from the group's frozen totals — the same
    //     `splitGroupTotalAcrossOccurrences` the build used, so the resulting multiset is identical
    //     to scan one's regardless of either scan's array order.
    const costShares = splitGroupTotalAcrossOccurrences(record.groupCostBasisUsd, record.occurrenceCount)
    const proceedsShares = splitGroupTotalAcrossOccurrences(record.groupProceedsUsd, record.occurrenceCount)
    const rebuiltOccurrences: MatchedLot[] = occurrences.map((lot, i) => {
      const costBasisUsd = costShares[i]
      const proceedsUsd = proceedsShares[i]
      return {
        ...lot,
        costBasisUsd,
        proceedsUsd,
        realizedPnlUsd: costBasisUsd === null || proceedsUsd === null ? null : Math.round((proceedsUsd - costBasisUsd) * 100) / 100,
        evidenceQuality: 'verified' as const,
      }
    })

    // 3d. The reconstructed group's own realized total must match the manifest's frozen figure, and
    //     every occurrence must satisfy the ONE canonical published-verified predicate.
    const rebuiltGroupPnl = rebuiltOccurrences.some((l) => l.realizedPnlUsd === null)
      ? null
      : Math.round(rebuiltOccurrences.reduce((sum, l) => sum + (l.realizedPnlUsd as number), 0) * 1e8) / 1e8
    if (!withinTolerance(rebuiltGroupPnl, record.groupRealizedPnlUsd, CANONICAL_TOTAL_TOLERANCE_USD)) {
      reasonCounts.manifest_realized_pnl_mismatch += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    if (!rebuiltOccurrences.every(isCanonicalVerifiedPublishedLot)) {
      reasonCounts.manifest_evidence_quality_mismatch += 1
      manifestReplayedButNotCanonicalVerifiedLotKeys.push(key)
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }

    // Counted per LOT, not per group — `manifest_replay_success` must stay comparable to the
    // manifest's own verifiedLotCount.
    reasonCounts.manifest_replay_success += rebuiltOccurrences.length
    selectedLotKeys.push(key)
    rebuiltOccurrences.forEach((rebuilt, i) => rebuiltByLot.set(occurrences[i], rebuilt))
  }

  // 4. Candidate-only lots — real, newly-priceable evidence, never merged into the published sample.
  const manifestKeySet = new Set(manifestDedupe.unique)
  const candidateNewEvidenceLotKeys = candidateDedupe.unique.filter((key) => !manifestKeySet.has(key))
  reasonCounts.manifest_candidate_only_lot = candidateNewEvidenceLotKeys.length

  // 5. Per-lot outcome is settled. Build the candidate published array ONCE (requirement #3).
  const perLotFailed = manifestLotsMissingCurrentEvidence.length > 0 || duplicates.hasDuplicates
  const selectedKeySet = new Set(selectedLotKeys)
  const buildPublished = (failed: boolean): MatchedLot[] => params.allCandidateLots.map((lot) => {
    const identity = identities.get(lot)
    const rebuilt = rebuiltByLot.get(lot)
    // FAIL CLOSED (requirement #4): when the manifest could not be replayed in full, NO verified lot
    // is published at all — the live candidate sample must never escape as canonical.
    if (failed) return isCanonicalVerifiedPublishedLot(lot) ? withheldFromPublication(lot) : lot
    // A manifest lot publishes its REBUILT canonical values, never the current scan's own.
    if (rebuilt && identity && selectedKeySet.has(identity.key)) return rebuilt
    // Everything else — candidate-only lots included — is withheld from publication.
    return isCanonicalVerifiedPublishedLot(lot) ? withheldFromPublication(lot) : lot
  })

  // 6. Prove the frozen result is INTERNALLY DERIVABLE before publishing it (requirement #4/#5):
  //    the total is SUMMED from the reconstructed lots, never copied off the manifest, and the
  //    fingerprints are RECOMPUTED over the reconstructed array and compared to the stored ones.
  let recomputedRealizedPnlUsd: number | null = null
  let recomputedFingerprints: DeterminismFingerprints | null = null
  let derivationFailed = false
  let fingerprintMismatchDiagnostic: FingerprintMismatchDiagnostic | null = null
  if (!perLotFailed) {
    const candidatePublished = buildPublished(false)
    const publishedVerified = candidatePublished.filter(isCanonicalVerifiedPublishedLot)
    recomputedRealizedPnlUsd = publishedVerified.length > 0
      ? sumQuantizedUsd(sortLotsByCanonicalIdentity(publishedVerified).map((l) => l.realizedPnlUsd))
      : null
    if (!withinTolerance(recomputedRealizedPnlUsd, params.manifest.realizedPnlUsd, CANONICAL_TOTAL_TOLERANCE_USD)) {
      reasonCounts.manifest_realized_total_mismatch += 1
      derivationFailed = true
    }
    recomputedFingerprints = params.computeFingerprints(candidatePublished, recomputedRealizedPnlUsd)
    const fingerprintDisagreements = [
      recomputedFingerprints.verifiedLotIdentityFingerprint !== params.manifest.verifiedLotIdentityFingerprint,
      recomputedFingerprints.acceptedHistoricalPriceFingerprint !== params.manifest.acceptedHistoricalPriceFingerprint,
      recomputedFingerprints.realizedPnlFingerprint !== params.manifest.realizedPnlFingerprint,
    ].filter(Boolean).length
    if (fingerprintDisagreements > 0) {
      reasonCounts.manifest_fingerprint_mismatch += fingerprintDisagreements
      derivationFailed = true
      // DIAGNOSTIC ONLY, DISCLOSED (fingerprint-mismatch audit task): built even though replay is
      // about to fail — see FingerprintMismatchDiagnostic's own header. Never changes `derivationFailed`
      // or `publishedLots` below; purely observational.
      fingerprintMismatchDiagnostic = buildFingerprintMismatchDiagnostic({
        manifest: params.manifest, recomputedFingerprints, recomputedRealizedPnlUsd, rebuiltByLot, identities,
      })
    }
  }

  const replayFailed = perLotFailed || derivationFailed
  const publishedLots = buildPublished(replayFailed)

  // See ManifestReplayResult's own header for the full disclosure. Computed from the LOCAL
  // `recomputedFingerprints` (before the outward-facing null-on-failure below) — this is the one
  // signal the caller needs to safely distinguish "stale but self-consistent manifest, safe to
  // rebuild" from every genuine failure mode, which must never trigger a refresh.
  const staleManifestCanonicalizationMismatch = !perLotFailed
    && recomputedFingerprints !== null
    && recomputedFingerprints.verifiedLotIdentityFingerprint === params.manifest.verifiedLotIdentityFingerprint
    && (recomputedFingerprints.acceptedHistoricalPriceFingerprint !== params.manifest.acceptedHistoricalPriceFingerprint
      || recomputedFingerprints.realizedPnlFingerprint !== params.manifest.realizedPnlFingerprint)

  return {
    outcome: replayFailed ? 'unavailable' : 'applied',
    publishedLots,
    forcePublicPnlUnavailable: replayFailed,
    // ATOMIC REPORTING, DISCLOSED: on failure this is EMPTY, because zero lots were actually
    // selected for publication — reporting the lots that happened to resolve before the failure
    // would claim a selection that never reached the published array, which is precisely the
    // audit-vs-reality mismatch this task exists to eliminate. The per-lot diagnostic detail
    // survives honestly in `reasonCounts`.
    selectedLotKeys: replayFailed ? [] : selectedLotKeys,
    candidateNewEvidenceLotKeys,
    manifestLotsMissingCurrentEvidence,
    reasonCounts,
    duplicates,
    recomputedRealizedPnlUsd: replayFailed ? null : recomputedRealizedPnlUsd,
    recomputedFingerprints: replayFailed ? null : recomputedFingerprints,
    manifestReplayedButNotCanonicalVerifiedLotKeys,
    fingerprintMismatchDiagnostic,
    staleManifestCanonicalizationMismatch,
  }
}

// ============================================================================
// AUDIT (requirement #8 of the prior task, extended per #2/#4/#7 here)
// ============================================================================

// LAST-KNOWN CANONICAL SAMPLE, DISCLOSED (requirement #4): the previous manifest's stored figures,
// preserved as clearly-labelled METADATA when replay fails. `availableForCurrentVerification` is
// always false here — these numbers describe a sample this scan could NOT re-verify, and must never
// be presented as freshly verified.
export type LastKnownCanonicalSample = {
  manifestVersion: number
  verifiedLotCount: number
  verifiedPricingCoverage: number | null
  realizedPnlUsd: number | null
  refreshedAt: number
  availableForCurrentVerification: false
}

export function buildLastKnownCanonicalSample(manifest: CanonicalPnlSampleManifest): LastKnownCanonicalSample {
  return {
    manifestVersion: manifest.manifestVersion,
    verifiedLotCount: manifest.verifiedLotCount,
    verifiedPricingCoverage: manifest.verifiedPricingCoverage,
    realizedPnlUsd: manifest.realizedPnlUsd,
    refreshedAt: manifest.refreshedAt,
    availableForCurrentVerification: false,
  }
}

export type CanonicalSampleManifestAudit = {
  manifestKey: string
  manifestFound: boolean
  manifestCreated: boolean
  manifestApplied: boolean
  manifestVersion: number | null
  manifestVerifiedLotCount: number | null
  currentCandidateVerifiedLotCount: number
  publishedVerifiedLotCount: number
  candidateNewEvidenceCount: number
  candidateNewEvidenceLotKeys: string[]
  manifestLotsMissingCurrentEvidence: string[]
  manifestEvidenceHydrated: boolean
  manifestIdentityMismatches: number
  manifestValidationFailures: number
  manifestWriteSuccess: boolean
  manifestWriteFailure: boolean
  refreshRequested: boolean
  refreshReason: string | null
  canonicalSampleEvidenceUnavailable: boolean
  replayReasonCounts: ManifestReplayReasonCounts
  manifestDuplicateLotKeys: string[]
  candidateDuplicateLotKeys: string[]
  manifestDuplicateEvidenceKeys: string[]
  lastKnownCanonicalSample: LastKnownCanonicalSample | null
  // REQUIREMENT #7: the exact lots that replayed but still fail the ONE canonical published-verified
  // predicate, plus a full breakdown of WHY any published lot fails it. This is what makes a
  // gate-vs-AYRI verified-count gap diagnosable instead of merely visible.
  manifestReplayedButNotCanonicalVerifiedLotKeys: string[]
  canonicalVerifiedPredicateReasonCounts: CanonicalVerifiedPredicateReasonCounts
  // REQUIREMENT #4/#5: the total re-derived by summing the reconstructed published lots — never
  // copied from the manifest. Null whenever replay did not produce a publishable canonical sample.
  recomputedRealizedPnlUsd: number | null
  // STALE-MANIFEST SELF-HEAL, DISCLOSED, ADDITIVE (stale-manifest self-heal follow-up task). See
  // ManifestReplayResult's own `staleManifestCanonicalizationMismatch` header for the exact
  // condition. `manifestRefreshAttempted`/`manifestRefreshApplied` are only ever true when
  // `staleManifestCanonicalizationMismatch` was true on the FIRST replay this scan ran — a genuine
  // identity mismatch, missing/invalid side evidence, cost/proceeds mismatch, invalid chronology, or
  // any other real divergence never sets any of these three fields.
  staleManifestCanonicalizationMismatch: boolean
  manifestRefreshAttempted: boolean
  manifestRefreshApplied: boolean
  manifestRefreshReason: string | null
}

export function emptyCanonicalSampleManifestAudit(manifestKey: string): CanonicalSampleManifestAudit {
  return {
    manifestKey,
    manifestFound: false,
    manifestCreated: false,
    manifestApplied: false,
    manifestVersion: null,
    manifestVerifiedLotCount: null,
    currentCandidateVerifiedLotCount: 0,
    publishedVerifiedLotCount: 0,
    candidateNewEvidenceCount: 0,
    candidateNewEvidenceLotKeys: [],
    manifestLotsMissingCurrentEvidence: [],
    manifestEvidenceHydrated: true,
    manifestIdentityMismatches: 0,
    manifestValidationFailures: 0,
    manifestWriteSuccess: false,
    manifestWriteFailure: false,
    refreshRequested: false,
    refreshReason: null,
    canonicalSampleEvidenceUnavailable: false,
    replayReasonCounts: emptyReplayReasonCounts(),
    manifestDuplicateLotKeys: [],
    candidateDuplicateLotKeys: [],
    manifestDuplicateEvidenceKeys: [],
    lastKnownCanonicalSample: null,
    manifestReplayedButNotCanonicalVerifiedLotKeys: [],
    canonicalVerifiedPredicateReasonCounts: emptyCanonicalVerifiedPredicateReasonCounts(),
    recomputedRealizedPnlUsd: null,
    staleManifestCanonicalizationMismatch: false,
    manifestRefreshAttempted: false,
    manifestRefreshApplied: false,
    manifestRefreshReason: null,
  }
}
