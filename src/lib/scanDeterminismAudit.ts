// MODULE — scanDeterminismAudit (determinism follow-up task, requirement #6).
//
// GOAL, DISCLOSED: a real, before/after-comparable fingerprint of the canonical FIFO/PnL result a
// scan produced — so "did this rescan reproduce the same verified-lot set and realized PnL" can be
// answered by comparing two small strings instead of eyeballing a diff of full lot arrays. Pure,
// deterministic, no I/O — every fingerprint here is a function of already-computed pipeline state
// (matchedLots, realizedPnlUsd), never a new source of truth. Comparing to a previous scan's
// fingerprint is the CALLER's responsibility (this module never itself persists or fetches one) —
// `previousScanFingerprint` is an optional input, and `deterministicComparedToPreviousScan` is
// `null` (never guessed true/false) whenever the caller didn't supply one to compare against.
//
// HASH CHOICE, DISCLOSED: reuses this codebase's own existing djb2-style pure hash convention
// (see src/modules/lotOpener/lotOpener.ts's `deterministicHash` for the precedent) rather than
// introducing a crypto import — this is an equality-comparison fingerprint, not a security control,
// so a compact, dependency-free hash is the right tool, matching this codebase's established
// pattern.

import type { MatchedLot } from '../modules/fifoEngine/types'

function deterministicHash(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// IDENTITY KEY, DISCLOSED: the same lot-identity fields already used elsewhere in this codebase for
// lot equality (chain/token/openedTxHash/closedTxHash/openedAt/closedAt — see pnlReconciliation.ts's
// own `lotKey`), plus `amount` — a lot with the same tx pair but a different matched quantity is a
// genuinely different match, not the same lot re-observed.
type FingerprintableLot = Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount' | 'evidenceQuality' | 'costBasisUsd' | 'proceedsUsd'>

function lotIdentityKey(lot: FingerprintableLot): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt, lot.amount].join(':')
}

export type ScanDeterminismAudit = {
  scanFingerprint: string
  matchedLotFingerprint: string
  verifiedLotIdentityFingerprint: string
  acceptedHistoricalPriceFingerprint: string
  realizedPnlFingerprint: string
  persistedEvidenceHits: number
  liveEvidenceMisses: number
  // null: no previous fingerprint was supplied to compare against (first scan, or caller hasn't
  // wired persistence for it yet) — never fabricated as true or false.
  deterministicComparedToPreviousScan: boolean | null
}

export function buildScanDeterminismAudit(params: {
  matchedLots: readonly FingerprintableLot[]
  realizedPnlUsd: number | null
  persistedEvidenceHits: number
  liveEvidenceMisses: number
  previousScanFingerprint?: string | null
}): ScanDeterminismAudit {
  // ALL SORTED, DISCLOSED: FIFO's own internal ordering is not itself a determinism guarantee this
  // module wants to assert on — two structurally-identical matches produced in a different array
  // order must fingerprint identically. Sorting here is fingerprinting-only; it never reorders or
  // mutates the caller's own `matchedLots` array.
  const matchedKeys = [...params.matchedLots].map(lotIdentityKey).sort()
  const matchedLotFingerprint = deterministicHash(matchedKeys.join('|'))

  const verifiedLots = params.matchedLots.filter((l) => l.evidenceQuality === 'verified')
  const verifiedKeys = verifiedLots.map(lotIdentityKey).sort()
  const verifiedLotIdentityFingerprint = deterministicHash(verifiedKeys.join('|'))

  // ACCEPTED HISTORICAL PRICE FINGERPRINT, DISCLOSED: the exact per-lot costBasisUsd/proceedsUsd
  // pair for every VERIFIED lot — this is what actually changes when a rescan accepts a different
  // historical price than a previous scan did (the reported nondeterminism), independent of whether
  // the lot SET itself (verifiedLotIdentityFingerprint) also changed.
  const priceKeys = verifiedLots.map((l) => `${lotIdentityKey(l)}:${l.costBasisUsd}:${l.proceedsUsd}`).sort()
  const acceptedHistoricalPriceFingerprint = deterministicHash(priceKeys.join('|'))

  const realizedPnlFingerprint = deterministicHash(params.realizedPnlUsd === null ? 'null' : params.realizedPnlUsd.toFixed(8))

  const scanFingerprint = deterministicHash([
    matchedLotFingerprint, verifiedLotIdentityFingerprint, acceptedHistoricalPriceFingerprint, realizedPnlFingerprint,
  ].join('|'))

  const deterministicComparedToPreviousScan = params.previousScanFingerprint == null
    ? null
    : params.previousScanFingerprint === scanFingerprint

  return {
    scanFingerprint,
    matchedLotFingerprint,
    verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint,
    persistedEvidenceHits: params.persistedEvidenceHits,
    liveEvidenceMisses: params.liveEvidenceMisses,
    deterministicComparedToPreviousScan,
  }
}
