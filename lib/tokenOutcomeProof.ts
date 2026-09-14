import { OUTCOME_POLICY, type TrackedOutcome } from './tokenOutcomes'

export type OutcomeProof = { verifiedTradingBlocked: true; observedAt: string; source: 'token_scanner'; scanId: string; reason: string }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
/** Read fresh server-owned scanner evidence only. Baseline risk/price loss cannot create this proof. */
export function afterScanProof(row: TrackedOutcome, scan: Record<string, unknown> | null, now = Date.now()): OutcomeProof | null {
  if (!scan || scan.chain !== row.chain || row.chain === 'solana') return null
  if (typeof scan.contract !== 'string' || scan.contract.toLowerCase() !== row.token_address.toLowerCase()) return null
  const started = scan.scanRequestStartedAt
  if (typeof started !== 'number' || !Number.isFinite(started) || started <= Date.parse(row.tracked_at) || started > now || now - started > OUTCOME_POLICY.staleMs) return null
  const prior = object(object(row.baseline_snapshot_json.baselineSecuritySignals).honeypot)
  const current = object(scan.honeypot)
  if (prior.isHoneypot !== false || prior.simulationSuccess !== true) return null
  if (current.isHoneypot !== true || current.honeypotStatus !== 'confirmed' || current.finalStatus !== 'risk_detected') return null
  if (typeof scan.scanRequestId !== 'string' || scan.scanRequestId === row.scan_id) return null
  return { verifiedTradingBlocked: true, observedAt: new Date(started).toISOString(), source: 'token_scanner', scanId: scan.scanRequestId,
    reason: 'A subsequent Token Scanner scan confirmed a honeypot after the original scan recorded a successful sell simulation.' }
}
