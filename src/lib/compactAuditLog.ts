// Log-size guard for the pipeline's diagnostic audits. Several audits carry per-lot / per-side /
// per-example arrays that made one scan's worker logs run to hundreds of KB, past what Vercel keeps
// per request — so the worker's own end-of-run lines (e.g. [worker-stage-timing]) were dropped.
// Logs get every scalar plus the first few items of each long array and its true length; the audit
// objects returned to callers and stored on results are never touched.

export const AUDIT_LOG_SAMPLE_SIZE = 3

/** PURE. A shallow copy of `audit` for logging: arrays longer than `sampleSize` become a sample plus `<key>Total`. */
export function compactAuditForLog(audit: object | null | undefined, sampleSize = AUDIT_LOG_SAMPLE_SIZE): Record<string, unknown> | null | undefined {
  if (!audit) return audit as null | undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(audit)) {
    if (Array.isArray(value) && value.length > sampleSize) {
      out[key] = value.slice(0, sampleSize)
      out[`${key}Total`] = value.length
    } else {
      out[key] = value
    }
  }
  return out
}
