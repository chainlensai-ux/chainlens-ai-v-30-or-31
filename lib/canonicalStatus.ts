/**
 * Canonical UI/API status schema for ChainLens.
 * All public-facing status fields must use one of these five values.
 * Raw machine states (burned, locked, team_controlled, etc.) are preserved
 * separately as rawState / rawLpState / rawReason.
 */
export type CanonicalStatus =
  | "verified"           // direct evidence confirms the check passed
  | "inferred"           // strong indirect evidence — high confidence but not direct proof
  | "partial"            // real data exists but incomplete or estimated
  | "not_applicable"     // protocol/chain design makes this check irrelevant
  | "unavailable_with_reason" // no usable data — provider empty, failed, or unsupported

/**
 * Maps any raw/legacy status string to a CanonicalStatus.
 * Mapping rules:
 *   verified data              → "verified"
 *   strong indirect evidence   → "inferred"
 *   incomplete real data       → "partial"
 *   protocol design irrelevant → "not_applicable"
 *   no usable data             → "unavailable_with_reason"
 */
export function toCanonical(raw: string | null | undefined): CanonicalStatus {
  switch (raw) {
    // Verified
    case 'ok':
    case 'verified':
    case 'burned':
    case 'locked':
      return 'verified'

    // Inferred (real signal but indirect)
    case 'inferred':
    case 'team_controlled':
      return 'inferred'

    // Partial (real but incomplete)
    case 'partial':
      return 'partial'

    // Not applicable (protocol/chain design)
    case 'not_applicable':
    case 'protocol':
    case 'concentrated_liquidity':
      return 'not_applicable'

    // Everything else: no usable data
    case 'error':
    case 'empty':
    case 'unavailable':
    case 'unavailable_with_reason':
    case 'unknown':
    case 'unverified':
    case 'insufficient_data':
    case 'no_pool':
    case 'unsupported':
    case 'needs_holder_confirmation':
    case 'no_signal_from_available_data':
    default:
      return 'unavailable_with_reason'
  }
}

/**
 * UI label for a CanonicalStatus — premium CORTEX wording only.
 * No provider names, no raw error strings.
 */
export function canonicalLabel(status: CanonicalStatus): string {
  switch (status) {
    case 'verified':              return 'Verified'
    case 'inferred':              return 'Inferred'
    case 'partial':               return 'Partial'
    case 'not_applicable':        return 'Not applicable'
    case 'unavailable_with_reason': return 'Open check'
  }
}
