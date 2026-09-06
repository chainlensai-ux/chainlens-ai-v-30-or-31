// TOKEN SCANNER PUBLIC STATUS VOCABULARY — DISCLOSED.
// Final user-facing Token Scanner / LP Safety / Clark token / CORTEX copy must never emit
// "Open Check", "Model Open Check", bare "Unknown", or a vague unavailable state.
// Allowed finals:
//   Verified
//   Partial: reason
//   Locked: reason
//   Watch: reason
//   Unsupported: reason
//   Unavailable: reason
//   Not Applicable: reason
//   Not Checked: reason
// Missing evidence always keeps an exact reason. This helper never fabricates proof.

export const TOKEN_SCANNER_ALLOWED_STATUS_KINDS = [
  'verified',
  'partial',
  'locked',
  'watch',
  'unsupported',
  'unavailable',
  'not_applicable',
  'not_checked',
] as const

export type TokenScannerPublicStatusKind = (typeof TOKEN_SCANNER_ALLOWED_STATUS_KINDS)[number]

export const FORBIDDEN_STATUS_VOCAB_RE = /\bmodel open check\b|\bopen check\b|\bopen-check\b/i
export const BARE_UNKNOWN_STATUS_RE = /^(unknown|n\/a|na|none|unverified|pending)$/i

const ALLOWED_PREFIXES: Array<{ kind: TokenScannerPublicStatusKind; prefix: string }> = [
  { kind: 'not_applicable', prefix: 'Not Applicable' },
  { kind: 'not_checked', prefix: 'Not Checked' },
  { kind: 'unsupported', prefix: 'Unsupported' },
  { kind: 'unavailable', prefix: 'Unavailable' },
  { kind: 'partial', prefix: 'Partial' },
  { kind: 'locked', prefix: 'Locked' },
  { kind: 'watch', prefix: 'Watch' },
  { kind: 'verified', prefix: 'Verified' },
]

export function hasForbiddenTokenScannerStatusVocab(text: string | null | undefined): boolean {
  if (!text) return false
  return FORBIDDEN_STATUS_VOCAB_RE.test(text)
}

export function defaultReasonForKind(kind: TokenScannerPublicStatusKind): string {
  switch (kind) {
    case 'verified': return 'direct evidence confirmed this check'
    case 'partial': return 'real evidence exists but the check is incomplete'
    case 'locked': return 'lock proof is present'
    case 'watch': return 'evidence supports a watch-level state'
    case 'unsupported': return 'this check is not supported for the selected chain or pool model'
    case 'unavailable': return 'evidence was not confirmed in this scan'
    case 'not_applicable': return 'this check does not apply to the detected pool model'
    case 'not_checked': return 'this check was not run in this scan'
  }
}

export function composeTokenScannerPublicStatus(
  kind: TokenScannerPublicStatusKind,
  reason?: string | null,
): string {
  const cleaned = sanitizeStatusReason(reason) || defaultReasonForKind(kind)
  if (kind === 'verified' && (!reason || /^(ok|verified|confirmed|direct evidence confirmed this check)$/i.test(cleaned))) {
    return 'Verified'
  }
  const label = ALLOWED_PREFIXES.find((row) => row.kind === kind)?.prefix ?? 'Unavailable'
  if (kind === 'verified') return `Verified: ${cleaned}`
  return `${label}: ${cleaned}`
}

export function sanitizeStatusReason(reason?: string | null): string {
  if (typeof reason !== 'string') return ''
  let text = reason.trim()
  if (!text) return ''
  text = text
    .replace(/\bmodel open check\b/gi, '')
    .replace(/\bopen check\b/gi, '')
    .replace(/\bopen-check\b/gi, '')
    .replace(/^[—–:\-\s]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (BARE_UNKNOWN_STATUS_RE.test(text)) return ''
  return text
}

function alreadyComposed(raw: string): { kind: TokenScannerPublicStatusKind; text: string } | null {
  const trimmed = raw.trim()
  for (const row of ALLOWED_PREFIXES) {
    const exact = new RegExp(`^${row.prefix}$`, 'i')
    const withReason = new RegExp(`^${row.prefix}\\s*[:—–-]\\s*(.+)$`, 'i')
    if (exact.test(trimmed)) {
      return { kind: row.kind, text: composeTokenScannerPublicStatus(row.kind) }
    }
    const match = trimmed.match(withReason)
    if (match) {
      return { kind: row.kind, text: composeTokenScannerPublicStatus(row.kind, match[1]) }
    }
  }
  return null
}

function classifyMachineStatus(raw: string): TokenScannerPublicStatusKind | 'passthrough' {
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!value) return 'unavailable'
  if (
    value === 'verified' || value === 'ok' || value === 'confirmed' || value === 'burned' ||
    value === 'burn' || value === 'passed' || value === 'sellable' || value === 'verified_clear'
  ) return 'verified'
  if (value === 'locked' || value === 'lockcontract') return 'locked'
  if (value === 'partial' || value === 'partial_evidence' || value === 'inferred' || value === 'incomplete') return 'partial'
  if (value === 'watch' || value === 'medium' || value === 'monitor') return 'watch'
  if (
    value === 'unsupported' || value === 'not_supported' || value === 'unsupported_on_robinhood' ||
    value === 'chain_unsupported'
  ) return 'unsupported'
  if (
    value === 'not_applicable' || value === 'notapplicable' || value === 'concentrated_liquidity' ||
    value === 'protocol' || value === 'protocol_or_gauge' || value === 'protocol_managed' ||
    value === 'n_a'
  ) return 'not_applicable'
  if (
    value === 'not_checked' || value === 'not_attempted' || value === 'skipped' ||
    value === 'fast_mode_skipped' || value === 'pending'
  ) return 'not_checked'
  if (
    value === 'open_check' || value === 'unavailable' || value === 'unavailable_with_reason' ||
    value === 'unknown' || value === 'unverified' || value === 'error' || value === 'failed' ||
    value === 'insufficient_data' || value === 'no_data' || value === 'timeout' ||
    value === 'timed_out' || value === 'provider_unavailable' || value === 'provider_timeout'
  ) return 'unavailable'
  if (
    value === 'team_controlled' || value === 'wallet_controlled' || value === 'wallet' ||
    value === 'no_pool' || value === 'low' || value === 'high' || value === 'deep' ||
    value === 'protected' || value === 'none' || value === 'expired' || value === 'contract' ||
    value === 'flagged'
  ) return 'passthrough'
  return 'passthrough'
}

const SPECIFIC_LABELS: Record<string, string> = {
  team_controlled: 'Wallet Controlled',
  wallet_controlled: 'Wallet Controlled',
  wallet: 'Wallet Controlled',
  burned: 'Burned',
  burn: 'Burned',
  locked: 'Locked',
  no_pool: 'Unavailable: no active liquidity pool found',
  low: 'Low',
  high: 'High',
  watch: 'Watch',
  protected: 'Protected',
  none: 'None',
  expired: 'Expired',
  deep: 'Deep',
  contract: 'Contract',
  flagged: 'Watch: flagged',
}

export function formatTokenScannerPublicStatus(
  raw: string | null | undefined,
  reason?: string | null,
  opts?: { fastModeSkipped?: boolean; fallbackKind?: TokenScannerPublicStatusKind },
): string {
  if (opts?.fastModeSkipped) {
    return composeTokenScannerPublicStatus(
      'not_checked',
      sanitizeStatusReason(reason) || 'fast scan skipped security simulation',
    )
  }
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) {
    return composeTokenScannerPublicStatus(opts?.fallbackKind ?? 'unavailable', reason)
  }
  if (FORBIDDEN_STATUS_VOCAB_RE.test(value) || BARE_UNKNOWN_STATUS_RE.test(value)) {
    const stripped = sanitizeStatusReason(value) || sanitizeStatusReason(reason)
    return composeTokenScannerPublicStatus('unavailable', stripped)
  }
  const composed = alreadyComposed(value)
  if (composed) {
    if (reason && !composed.text.includes(sanitizeStatusReason(reason))) {
      const extra = sanitizeStatusReason(reason)
      if (extra && composed.kind !== 'verified') {
        return composeTokenScannerPublicStatus(composed.kind, extra)
      }
    }
    return composed.text
  }
  const kind = classifyMachineStatus(value)
  if (kind !== 'passthrough') {
    return composeTokenScannerPublicStatus(kind, reason || (kind === 'verified' ? null : value))
  }
  const machineKey = value.toLowerCase().replace(/[\s-]+/g, '_')
  if (SPECIFIC_LABELS[machineKey]) return SPECIFIC_LABELS[machineKey]
  const cleaned = value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned || BARE_UNKNOWN_STATUS_RE.test(cleaned) || FORBIDDEN_STATUS_VOCAB_RE.test(cleaned)) {
    return composeTokenScannerPublicStatus('unavailable', reason)
  }
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function rewriteForbiddenStatusVocab(
  text: string,
  fallbackReason = 'evidence was not confirmed in this scan',
): string {
  if (!text) return composeTokenScannerPublicStatus('unavailable', fallbackReason)
  let out = text
  out = out.replace(/\bModel Open Check\b/gi, `Unavailable: pool model could not be verified`)
  out = out.replace(/\bOpen Checks\b/gi, 'Evidence Gaps')
  out = out.replace(/\bOpen Check\s*[—–:-]\s*/gi, 'Unavailable: ')
  out = out.replace(/\bOpen Check\b/gi, `Unavailable: ${fallbackReason}`)
  out = out.replace(/\bopen check\b/gi, `Unavailable: ${fallbackReason}`)
  if (BARE_UNKNOWN_STATUS_RE.test(out.trim())) {
    return composeTokenScannerPublicStatus('unavailable', fallbackReason)
  }
  return out
}

export function clarkPartialMustNotBecomeOpenCheck(verdict: string, reason?: string | null): string {
  const v = verdict.trim()
  if (/partial evidence/i.test(v) || /^partial\b/i.test(v)) {
    return composeTokenScannerPublicStatus('partial', reason || v.replace(/^partial(?:\s*evidence)?\s*[:—–-]?\s*/i, '') || 'core evidence incomplete')
  }
  if (FORBIDDEN_STATUS_VOCAB_RE.test(v) || /^unknown$/i.test(v)) {
    return composeTokenScannerPublicStatus('unavailable', reason || 'insufficient evidence')
  }
  return rewriteForbiddenStatusVocab(v, reason || undefined)
}
