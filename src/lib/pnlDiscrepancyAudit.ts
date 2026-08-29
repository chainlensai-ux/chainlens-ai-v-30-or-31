// MODULE — pnlDiscrepancyAudit
//
// WHY, DISCLOSED (Wallet Scanner trust-gate task — confirmed production report: wallet
// 0x8de9ac2123c06fb6f8afa2f55a39fb670a50fbc7 published a bounded-sample realized PnL of
// -$10,667.43 while a genuinely separate internal read-model, pnlEngine, computed -$17,311.93 for
// the same wallet from the same underlying events — an ~$6.6k/68% disagreement — while
// publicPnlStatus was already 'partial' with pricingCoverage 0.6271, criticalTradeEvidenceMissing
// 36, and genuineUnmatchedSells 12. None of those real, already-computed signals were ever
// surfaced together, so a bounded-sample headline could look as definitive as a fully verified one
// even when the codebase's own two independent engines couldn't agree on it).
//
// WHAT THIS DOES, DISCLOSED: reads real, ALREADY-COMPUTED values from pnlReconciliation.ts's own
// `reconcile()` (canonical realizedPnlUsd, the alternate pnlEngine's own realizedPnlUsd, the public
// gate's own coverage/evidence counts, the published matched-lot array, and the real mismatch/
// unmatched-sell identities already tracked there) and combines them into one audit record plus a
// same-scan trust-gate decision. Never recomputes FIFO, never re-prices a lot, never calls a
// provider, never compares against any external service (Nansen or otherwise) — `externalComparatorHint`
// exists purely as an optional slot a human can attach manually when reporting a discrepancy; this
// module itself always leaves it null.
//
// FAIL-OPEN ON MISSING DATA, DISCLOSED: every derived field (divergence, top-N lists) degrades to
// null/empty rather than guessed when its real inputs are missing — never a fabricated number
// standing in for "unknown".

import type { MatchedLot, UnmatchedEventIdentity } from '../modules/fifoEngine/types'
import type { PnlMismatchClass } from './pnlReconciliation'

// SAME KEY FORMAT AS pnlReconciliation.ts's OWN (module-private) `lotKey`, DISCLOSED: duplicated
// here (a one-line pure function) rather than importing a private symbol — this module reads the
// SAME `mismatches` Map pnlReconciliation.ts itself builds and keys with this exact formula, so the
// two must stay byte-identical. If pnlReconciliation.ts's own `lotKey` ever changes, this one must
// change with it (both live in this session's own PnL-correctness surface).
function lotKey(lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt'>): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt].join(':')
}

// THRESHOLDS, DISCLOSED (this task's own explicit rule set) — deliberately not env-configurable,
// same "a containment rule a stray environment variable could silently loosen is not a rule"
// reasoning already used elsewhere in this codebase's cost/gate ceilings.
export const ENGINE_DIVERGENCE_ABS_THRESHOLD_USD = 250
export const ENGINE_DIVERGENCE_PCT_THRESHOLD = 0.10
export const PRICING_COVERAGE_TRUST_THRESHOLD = 0.85

export const PARTIAL_TRUST_GATE_HEADLINE_LABEL = 'Partial verified sample — not comparable to Nansen yet'

// CALM PUBLIC WORDING, DISCLOSED (Wallet Scanner second-pass audit, task 3 — "do NOT show scary raw
// integrity/debug language to normal users unless it is actionable" / "do NOT hide real integrity
// issues from debug/admin"). PARTIAL_TRUST_GATE_HEADLINE_LABEL above is UNCHANGED and still the real,
// technical label — it is never deleted, and every trust-gate reason code/divergence figure it
// describes stays fully computed and available. This is a SEPARATE, calmer label shown to normal
// users by default; the technical one moves to an expandable "Technical integrity details" section
// (see PnlStatusCard.tsx's own BoundedSampleDisclosure.technicalLabel).
export const PARTIAL_TRUST_GATE_PUBLIC_LABEL = 'Realized PnL is verified for the closed lots found in this scan.'

export type PnlDiscrepancyReasonCode =
  | 'engine_divergence_exceeds_threshold'
  | 'pricing_coverage_below_threshold'
  | 'critical_trade_evidence_missing'
  | 'genuine_unmatched_sells_present'

export type PnlLotPriceSourceHint = 'recovered' | 'priced' | 'unpriced'

// PER-LOT CONTRIBUTOR DEBUG, DISCLOSED (this task's explicit requirement #3): every field here is
// read directly off the real, already-verified/reconciled MatchedLot — never a second computation.
// `entryPriceUsd`/`exitPriceUsd` are the lot's own real costBasisUsd/proceedsUsd divided by its own
// real amount (simple arithmetic over already-real fields, not a new price lookup). `priceSourceHint`
// is the coarsest HONEST signal this layer actually has — MatchedLot itself only carries
// `evidenceQuality: 'verified' | 'unpriced'`, and pnlReconciliation's own `mismatches` map is the
// only place a finer "was this price recovered" signal exists at this layer. A finer per-lot
// provenance (primary/fallback/ratio/synthetic/router-corrected/receipt-derived) is NOT threaded
// this far down the pipeline today (see src/pipeline/priceLotsForWallet.ts's own internal pricing
// dictionaries, which never reach pnlReconciliation.ts) — reported honestly as `null` via the
// `receiptOrTransferDerived` field below rather than guessed, exactly this codebase's own
// established "honest null over fabricated precision" convention (e.g. fetchHoldings.ts's
// `lastActivityAt`).
export type PnlLotContributor = {
  lotId: string
  token: string
  chain: string
  openedAt: number
  closedAt: number
  openedTxHash: string // buy tx
  closedTxHash: string // sell tx
  realizedPnlUsd: number | null
  costBasisUsd: number | null
  proceedsUsd: number | null
  entryPriceUsd: number | null
  exitPriceUsd: number | null
  evidenceQuality: MatchedLot['evidenceQuality']
  priceSourceHint: PnlLotPriceSourceHint
  // HONEST NULL, DISCLOSED: whether this lot's price was receipt-decoded, a plain wallet-to-wallet
  // transfer, or synthetic is not a signal MatchedLot/pnlReconciliation carries at this layer —
  // reported as the real null it is rather than guessed at from `priceSourceHint` alone.
  receiptOrTransferDerived: null
}

export type TokenCount = { chain: string; token: string; count: number }

export type PnlDiscrepancyAudit = {
  // MANUAL-ONLY, DISCLOSED (this task's explicit rule #4): never set by this module itself — a
  // caller reporting a real external discrepancy (e.g. a support ticket referencing Nansen) may
  // attach this by hand; buildPnlDiscrepancyAudit() below always leaves it null.
  externalComparatorHint: 'nansen' | null
  canonicalRealizedPnlUsd: number | null
  alternateEngineRealizedPnlUsd: number | null
  engineDivergenceUsd: number | null
  engineDivergencePct: number | null
  verifiedLotCount: number
  structuralClosedLots: number
  pricingCoverage: number | null
  criticalTradeEvidenceMissing: number
  genuineUnmatchedSells: number
  largestNegativeClosedLotsTop10: PnlLotContributor[]
  largestPositiveClosedLotsTop10: PnlLotContributor[]
  topMissingEvidenceTokens: TokenCount[]
  topUnmatchedSellTokens: TokenCount[]
  likelyReasonCodes: PnlDiscrepancyReasonCode[]
  // TRUST GATE, DISCLOSED (this task's explicit rule #1): true only when the caller's own
  // `publicPnlStatus` is 'partial' AND at least one real reason code above fired — never for a
  // fully verified ('available') or already-unavailable result, and never from this module
  // guessing at status on its own (the caller supplies it).
  trustGateTriggered: boolean
  headlineOverrideLabel: string | null
}

function toContributor(lot: MatchedLot, mismatchByKey: ReadonlyMap<string, PnlMismatchClass>): PnlLotContributor {
  const classification = mismatchByKey.get(lotKey(lot)) ?? null
  const entryPriceUsd = lot.costBasisUsd != null && lot.amount > 0 ? lot.costBasisUsd / lot.amount : null
  const exitPriceUsd = lot.proceedsUsd != null && lot.amount > 0 ? lot.proceedsUsd / lot.amount : null
  const priceSourceHint: PnlLotPriceSourceHint = classification === 'priceRecovered'
    ? 'recovered'
    : lot.evidenceQuality === 'verified' ? 'priced' : 'unpriced'
  return {
    lotId: lot.lotId, token: lot.token, chain: lot.chain, openedAt: lot.openedAt, closedAt: lot.closedAt,
    openedTxHash: lot.openedTxHash, closedTxHash: lot.closedTxHash,
    realizedPnlUsd: lot.realizedPnlUsd, costBasisUsd: lot.costBasisUsd, proceedsUsd: lot.proceedsUsd,
    entryPriceUsd, exitPriceUsd, evidenceQuality: lot.evidenceQuality, priceSourceHint,
    receiptOrTransferDerived: null,
  }
}

// Parses `chain`/`token` back out of a real lotKey (`chain:token:openedTx:closedTx:openedAt:closedAt`)
// or a dust-prefixed key (`dust:chain:token:...`) — both real key shapes pnlReconciliation.ts's own
// `mismatches` map actually produces. Returns null for any key that doesn't match either shape
// (e.g. a future mismatch kind keyed differently) rather than guessing a token from a malformed split.
function parseChainTokenFromMismatchKey(key: string): { chain: string; token: string } | null {
  const parts = (key.startsWith('dust:') ? key.slice(5) : key).split(':')
  if (parts.length < 2) return null
  return { chain: parts[0], token: parts[1] }
}

function topTokenCounts(entries: Iterable<{ chain: string; token: string }>, limit = 10): TokenCount[] {
  const counts = new Map<string, TokenCount>()
  for (const { chain, token } of entries) {
    const key = `${chain}:${token.toLowerCase()}`
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else counts.set(key, { chain, token, count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.token.localeCompare(b.token)).slice(0, limit)
}

export type BuildPnlDiscrepancyAuditParams = {
  publicPnlStatus: 'available' | 'partial' | 'unavailable'
  canonicalRealizedPnlUsd: number | null
  alternateEngineRealizedPnlUsd: number | null
  verifiedLotCount: number
  structuralClosedLots: number
  pricingCoverage: number | null
  criticalTradeEvidenceMissing: number
  genuineUnmatchedSells: number
  publishedMatchedLots: readonly MatchedLot[]
  mismatches: ReadonlyMap<string, PnlMismatchClass>
  unmatchedSellEvents: readonly UnmatchedEventIdentity[]
}

// TEST-FIXTURE HELPER, DISCLOSED: same "emptyXAudit()" convention this codebase already uses
// elsewhere (e.g. canonicalPnlSampleManifest.ts's emptyCanonicalSampleManifestAudit) — an honest,
// all-null/zero/empty default for callers/fixtures that haven't wired real discrepancy data.
export function emptyPnlDiscrepancyAudit(): PnlDiscrepancyAudit {
  return {
    externalComparatorHint: null,
    canonicalRealizedPnlUsd: null,
    alternateEngineRealizedPnlUsd: null,
    engineDivergenceUsd: null,
    engineDivergencePct: null,
    verifiedLotCount: 0,
    structuralClosedLots: 0,
    pricingCoverage: null,
    criticalTradeEvidenceMissing: 0,
    genuineUnmatchedSells: 0,
    largestNegativeClosedLotsTop10: [],
    largestPositiveClosedLotsTop10: [],
    topMissingEvidenceTokens: [],
    topUnmatchedSellTokens: [],
    likelyReasonCodes: [],
    trustGateTriggered: false,
    headlineOverrideLabel: null,
  }
}

// PURE, exported for direct testing. Never throws — every derived field defends against null/empty
// real inputs by degrading to null/empty, never guessing.
export function buildPnlDiscrepancyAudit(params: BuildPnlDiscrepancyAuditParams): PnlDiscrepancyAudit {
  const {
    publicPnlStatus, canonicalRealizedPnlUsd, alternateEngineRealizedPnlUsd,
    verifiedLotCount, structuralClosedLots, pricingCoverage,
    criticalTradeEvidenceMissing, genuineUnmatchedSells,
    publishedMatchedLots, mismatches, unmatchedSellEvents,
  } = params

  const engineDivergenceUsd = canonicalRealizedPnlUsd != null && alternateEngineRealizedPnlUsd != null
    ? Math.abs(canonicalRealizedPnlUsd - alternateEngineRealizedPnlUsd)
    : null
  // PERCENT DENOMINATOR, DISCLOSED: the larger of the two absolute magnitudes (never the smaller,
  // which would inflate the percentage; never a fixed constant, which would misrepresent genuinely
  // small wallets) — floored at $1 so a near-zero canonical figure can never manufacture a
  // near-infinite percentage from a tiny absolute difference.
  const engineDivergencePct = engineDivergenceUsd != null
    ? engineDivergenceUsd / Math.max(Math.abs(canonicalRealizedPnlUsd ?? 0), Math.abs(alternateEngineRealizedPnlUsd ?? 0), 1)
    : null

  const reasonCodes: PnlDiscrepancyReasonCode[] = []
  if (engineDivergenceUsd != null && (engineDivergenceUsd > ENGINE_DIVERGENCE_ABS_THRESHOLD_USD || (engineDivergencePct != null && engineDivergencePct > ENGINE_DIVERGENCE_PCT_THRESHOLD))) {
    reasonCodes.push('engine_divergence_exceeds_threshold')
  }
  if (pricingCoverage != null && pricingCoverage < PRICING_COVERAGE_TRUST_THRESHOLD) {
    reasonCodes.push('pricing_coverage_below_threshold')
  }
  if (criticalTradeEvidenceMissing > 0) {
    reasonCodes.push('critical_trade_evidence_missing')
  }
  if (genuineUnmatchedSells > 0) {
    reasonCodes.push('genuine_unmatched_sells_present')
  }

  const trustGateTriggered = publicPnlStatus === 'partial' && reasonCodes.length > 0

  const pricedLots = publishedMatchedLots.filter((l) => l.realizedPnlUsd != null)
  const negative = [...pricedLots].filter((l) => (l.realizedPnlUsd as number) < 0)
    .sort((a, b) => (a.realizedPnlUsd as number) - (b.realizedPnlUsd as number)).slice(0, 10)
  const positive = [...pricedLots].filter((l) => (l.realizedPnlUsd as number) > 0)
    .sort((a, b) => (b.realizedPnlUsd as number) - (a.realizedPnlUsd as number)).slice(0, 10)

  const missingEvidenceTokens = [...mismatches.entries()]
    .filter(([, classification]) => classification === 'priceUnavailable')
    .map(([key]) => parseChainTokenFromMismatchKey(key))
    .filter((v): v is { chain: string; token: string } => v !== null)

  return {
    externalComparatorHint: null,
    canonicalRealizedPnlUsd, alternateEngineRealizedPnlUsd, engineDivergenceUsd, engineDivergencePct,
    verifiedLotCount, structuralClosedLots, pricingCoverage,
    criticalTradeEvidenceMissing, genuineUnmatchedSells,
    largestNegativeClosedLotsTop10: negative.map((l) => toContributor(l, mismatches)),
    largestPositiveClosedLotsTop10: positive.map((l) => toContributor(l, mismatches)),
    topMissingEvidenceTokens: topTokenCounts(missingEvidenceTokens),
    topUnmatchedSellTokens: topTokenCounts(unmatchedSellEvents.map((e) => ({ chain: e.chain, token: e.token }))),
    likelyReasonCodes: reasonCodes,
    trustGateTriggered,
    headlineOverrideLabel: trustGateTriggered ? PARTIAL_TRUST_GATE_HEADLINE_LABEL : null,
  }
}
