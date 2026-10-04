// src/lib/pnlRepeatScanDeterminism.ts — `[pnl-repeat-scan-determinism]`: does this scan reproduce the
// previous scan of the same wallet/chains/window exactly?
//
// The fingerprints come from scanDeterminismAudit.ts (structural lot set, verified lot identities,
// accepted historical prices, realized PnL). The previous scan's values are kept in KV per wallet scope;
// a scan only reports `deterministic: false` with the FIRST field that moved, so a genuine evidence change
// (new trades, a repaired accepted record) is distinguishable from provider timing noise. Diagnostic
// only — it never changes what a scan publishes, and a KV failure is silent.

export const REPEAT_SCAN_SNAPSHOT_VERSION = 1 as const
const SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60

export type RepeatScanSnapshot = {
  v: typeof REPEAT_SCAN_SNAPSHOT_VERSION
  scope: string
  matchedLotFingerprint: string
  verifiedLotIdentityFingerprint: string
  acceptedHistoricalPriceFingerprint: string
  realizedPnlFingerprint: string
  verifiedLotCount: number
  structuralLotCount: number
  realizedPnlUsd: number | null
  recordedAt: number
}

/** Compared in this order; the first that differs is reported. */
const COMPARED_FIELDS = [
  'matchedLotFingerprint',
  'verifiedLotIdentityFingerprint',
  'acceptedHistoricalPriceFingerprint',
  'realizedPnlFingerprint',
  'verifiedLotCount',
  'structuralLotCount',
  'realizedPnlUsd',
] as const

export type RepeatScanDeterminismAudit = {
  scope: string
  matchedLotFingerprint: string
  verifiedLotIdentityFingerprint: string
  acceptedHistoricalPriceFingerprint: string
  realizedPnlFingerprint: string
  verifiedLotCount: number
  structuralLotCount: number
  coverage: number | null
  realizedPnlUsd: number | null
  previousVerifiedLotCount: number | null
  previousRealizedPnlUsd: number | null
  /** null on the first scan of this scope (nothing to compare). */
  deterministic: boolean | null
  firstDifference: { field: (typeof COMPARED_FIELDS)[number]; previous: unknown; current: unknown } | null
  /**
   * Why it may legitimately differ: the structural lot set changed (new chain activity), or only the
   * accepted evidence / prices changed for the same lot set. Never a claim that a change was correct.
   */
  differenceKind: 'structural_lot_set_changed' | 'accepted_evidence_changed' | 'verified_selection_changed' | null
}

export function repeatScanScope(walletAddress: string, chains: readonly string[], windowDays: number): string {
  return `pnl-repeat-scan:v${REPEAT_SCAN_SNAPSHOT_VERSION}:${walletAddress.toLowerCase()}:${[...chains].map((c) => c.toLowerCase()).sort().join(',')}:${windowDays}d`
}

export function buildRepeatScanSnapshot(scope: string, current: Omit<RepeatScanSnapshot, 'v' | 'scope' | 'recordedAt'>, now: number): RepeatScanSnapshot {
  return { v: REPEAT_SCAN_SNAPSHOT_VERSION, scope, ...current, recordedAt: now }
}

export function parseRepeatScanSnapshot(raw: unknown, scope: string): RepeatScanSnapshot | null {
  const r = raw as Partial<RepeatScanSnapshot> | null
  if (!r || typeof r !== 'object' || r.v !== REPEAT_SCAN_SNAPSHOT_VERSION || r.scope !== scope) return null
  if (typeof r.matchedLotFingerprint !== 'string' || typeof r.verifiedLotCount !== 'number') return null
  return r as RepeatScanSnapshot
}

export function buildRepeatScanDeterminismAudit(current: RepeatScanSnapshot, previous: RepeatScanSnapshot | null): RepeatScanDeterminismAudit {
  let firstDifference: RepeatScanDeterminismAudit['firstDifference'] = null
  if (previous) {
    for (const field of COMPARED_FIELDS) {
      if (current[field] !== previous[field]) {
        firstDifference = { field, previous: previous[field], current: current[field] }
        break
      }
    }
  }
  const differenceKind: RepeatScanDeterminismAudit['differenceKind'] = !firstDifference
    ? null
    : firstDifference.field === 'matchedLotFingerprint' || firstDifference.field === 'structuralLotCount'
      ? 'structural_lot_set_changed'
      : firstDifference.field === 'verifiedLotIdentityFingerprint' || firstDifference.field === 'verifiedLotCount'
        ? 'verified_selection_changed'
        : 'accepted_evidence_changed'
  return {
    scope: current.scope,
    matchedLotFingerprint: current.matchedLotFingerprint,
    verifiedLotIdentityFingerprint: current.verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint: current.acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint: current.realizedPnlFingerprint,
    verifiedLotCount: current.verifiedLotCount,
    structuralLotCount: current.structuralLotCount,
    coverage: current.structuralLotCount > 0 ? Math.round((current.verifiedLotCount / current.structuralLotCount) * 10000) / 100 : null,
    realizedPnlUsd: current.realizedPnlUsd,
    previousVerifiedLotCount: previous?.verifiedLotCount ?? null,
    previousRealizedPnlUsd: previous?.realizedPnlUsd ?? null,
    deterministic: previous ? firstDifference === null : null,
    firstDifference,
    differenceKind,
  }
}

export type RepeatScanKv = {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, opts?: { ex?: number }) => Promise<unknown>
}

/** Reads the previous snapshot, audits, then stores this scan's snapshot. Never throws. */
export async function auditAndRecordRepeatScan(kv: RepeatScanKv | null, current: RepeatScanSnapshot): Promise<RepeatScanDeterminismAudit> {
  let previous: RepeatScanSnapshot | null = null
  if (kv) {
    try { previous = parseRepeatScanSnapshot(await kv.get(current.scope), current.scope) } catch { previous = null }
  }
  const audit = buildRepeatScanDeterminismAudit(current, previous)
  if (kv) {
    try { await kv.set(current.scope, current, { ex: SNAPSHOT_TTL_SECONDS }) } catch { /* diagnostic only */ }
  }
  return audit
}
