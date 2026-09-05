// TOKEN SCANNER HOLDER COUNT HONESTY — DISCLOSED.
// 0, unavailable, capped, and not-attempted must never look the same.
// A provider total is exact only when the reason says so. Partial indexed rows
// are never displayed as a complete holder universe, and never as 0%.

export type TokenScannerHolderCountReason =
  | 'holder_count_from_provider_total'
  | 'holder_count_from_normalized_rows'
  | 'holder_count_from_resolver'
  | 'holder_count_unavailable_with_reason'
  | 'ok'
  | 'capped'
  | 'no_api_key'
  | 'rate_limited'
  | 'http_error'
  | 'timeout'
  | 'no_data'
  | 'chain_unsupported'
  | 'not_attempted'
  | string

export type HolderCountDisplay = {
  display: string
  exact: boolean
  usableForConcentration: boolean
  holderCount: number | null
  holderCountReason: string
  holderRowsStatus: 'ok' | 'partial' | 'unavailable' | 'not_attempted'
  concentrationStatus: 'verified' | 'partial' | 'unavailable' | 'not_checked'
}

const UNAVAILABLE_REASONS = new Set([
  'holder_count_unavailable_with_reason',
  'no_api_key',
  'rate_limited',
  'http_error',
  'timeout',
  'no_data',
  'chain_unsupported',
  'not_attempted',
])

export function isExactHolderCountReason(reason?: string | null, isCapped?: boolean | null): boolean {
  if (isCapped === true) return false
  return reason === 'holder_count_from_provider_total' || reason === 'ok'
}

export function holderRowsStatusFrom(input: {
  holderCountReason?: string | null
  holderRowsReturned?: number | null
  holderCount?: number | null
}): HolderCountDisplay['holderRowsStatus'] {
  const reason = input.holderCountReason ?? ''
  if (reason === 'not_attempted') return 'not_attempted'
  if ((input.holderRowsReturned ?? 0) > 0 || reason === 'holder_count_from_normalized_rows' || reason === 'holder_count_from_resolver') {
    return 'partial'
  }
  if (isExactHolderCountReason(reason) && (input.holderCount ?? 0) > 0) return 'ok'
  return 'unavailable'
}

export function formatHolderCountDisplay(input: {
  holderCount?: number | null
  holderCountReason?: string | null
  isCapped?: boolean | null
  holderRowsReturned?: number | null
  reasonText?: string | null
}): HolderCountDisplay {
  const reason = input.holderCountReason || (input.holderCount == null ? 'holder_count_unavailable_with_reason' : 'holder_count_from_provider_total')
  const rows = input.holderRowsReturned ?? 0
  const count = typeof input.holderCount === 'number' && Number.isFinite(input.holderCount) ? input.holderCount : null
  const exact = isExactHolderCountReason(reason, input.isCapped) && count != null && count > 0
  const rowsStatus = holderRowsStatusFrom({ holderCountReason: reason, holderRowsReturned: rows, holderCount: count })
  const unavailable = UNAVAILABLE_REASONS.has(reason) || count == null
  const reasonText = (input.reasonText || '').trim()

  if (reason === 'not_attempted') {
    return {
      display: 'Not Checked: holder count was not requested in this scan',
      exact: false,
      usableForConcentration: false,
      holderCount: null,
      holderCountReason: reason,
      holderRowsStatus: 'not_attempted',
      concentrationStatus: 'not_checked',
    }
  }

  if (unavailable && rows === 0) {
    const why = reasonText
      || (reason === 'no_api_key' ? 'holder provider is not configured'
        : reason === 'rate_limited' ? 'holder provider rate-limited this request'
        : reason === 'timeout' ? 'holder provider timed out'
        : reason === 'chain_unsupported' ? 'holder provider does not support this chain'
        : reason === 'http_error' ? 'holder provider returned an HTTP error'
        : reason === 'no_data' ? 'holder provider returned no data'
        : 'no usable holder count was returned')
    return {
      display: `Unavailable: ${why}`,
      exact: false,
      usableForConcentration: false,
      holderCount: null,
      holderCountReason: reason,
      holderRowsStatus: 'unavailable',
      concentrationStatus: 'unavailable',
    }
  }

  if (count === 0 && rows === 0) {
    return {
      display: 'Unavailable: provider returned no holder rows',
      exact: false,
      usableForConcentration: false,
      holderCount: null,
      holderCountReason: reason,
      holderRowsStatus: 'unavailable',
      concentrationStatus: 'unavailable',
    }
  }

  if (exact) {
    return {
      display: count!.toLocaleString(),
      exact: true,
      usableForConcentration: true,
      holderCount: count,
      holderCountReason: reason,
      holderRowsStatus: rowsStatus,
      concentrationStatus: 'verified',
    }
  }

  const shown = count ?? rows
  const capped = input.isCapped === true || reason === 'holder_count_from_normalized_rows' || reason === 'holder_count_from_resolver' || reason === 'capped'
  return {
    display: capped ? `${shown.toLocaleString()}+` : shown.toLocaleString(),
    exact: false,
    usableForConcentration: rows > 0,
    holderCount: shown,
    holderCountReason: reason,
    holderRowsStatus: 'partial',
    concentrationStatus: 'partial',
  }
}
