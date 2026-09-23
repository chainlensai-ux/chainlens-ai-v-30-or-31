// TOKEN SCANNER HOLDER COUNT HONESTY — DISCLOSED.
// 0, unavailable, capped, and not-attempted must never look the same.
// A provider total is exact only when the reason says so. Partial indexed rows
// are never displayed as a complete holder universe, and never as 0%.
//
// Holder COUNT and supply CONCENTRATION are different measurements:
// - Count = provider total / indexed account count for this exact chain+contract.
// - Concentration = % of token supply held by top indexed wallets (identity-matched).
// DexScreener pair pages may show another holder figure from their own indexer —
// that is not this count, not this concentration series, and never proof either is wrong.

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

/** Shown next to holder count / concentration so external DexScreener figures are not treated as the same series. */
export const HOLDER_VS_CONCENTRATION_DISCLAIMER =
  'Holder count and top-holder concentration are different measurements. Count is a provider total (or token-account count) for this exact chain and contract. Concentration is percent of supply held by the top indexed wallets. DexScreener may show a different holder figure — do not treat that as the same metric or as proof ChainLens concentration is wrong.'

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
    // Exact count is real count evidence only. Concentration requires identity-matched
    // top-holder balance percentages — never inferred from a bare total (Base Radar rule).
    return {
      display: count!.toLocaleString(),
      exact: true,
      usableForConcentration: false,
      holderCount: count,
      holderCountReason: reason,
      holderRowsStatus: rowsStatus,
      concentrationStatus: 'not_checked',
    }
  }

  const shown = count ?? rows
  const capped = input.isCapped === true || reason === 'holder_count_from_normalized_rows' || reason === 'holder_count_from_resolver' || reason === 'capped'
  return {
    display: capped ? `${shown.toLocaleString()}+` : shown.toLocaleString(),
    exact: false,
    // Indexed rows can feed concentration only when percentages exist; the caller gates that.
    usableForConcentration: false,
    holderCount: shown,
    holderCountReason: reason,
    holderRowsStatus: 'partial',
    // Row presence without verified percents is not concentration evidence.
    concentrationStatus: 'not_checked',
  }
}

/**
 * Where an exact provider holder total came from and as of when. A total with no as-of time
 * cannot be compared against another indexer's figure (e.g. DexScreener): a gap could be index
 * lag, a different counting definition, or neither. This never changes the count itself.
 */
export type HolderCountProvenance = {
  provider: 'goldrush' | 'moralis' | null
  /** GoldRush chain identifier that answered (Robinhood tries 'robinhood-mainnet' then '4663'). */
  chainIdentifier: string | null
  /** Provider's own index timestamp for this response, when it returns one. */
  providerUpdatedAt: string | null
  providerTotal: number | null
}

const numericTotal = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Mirrors the route's selection order exactly: GoldRush data.pagination, GoldRush pagination, then Moralis total. */
type HolderTotalResponse = {
  data?: { pagination?: { total_count?: unknown } | null; updated_at?: unknown } | null
  pagination?: { total_count?: unknown } | null
  updated_at?: unknown
  total?: unknown
  __chainUsed?: unknown
} | null

export function holderCountProvenance(goldrushRaw: unknown, moralisRaw: unknown): HolderCountProvenance {
  const gr = (goldrushRaw ?? null) as HolderTotalResponse
  const grTotal = gr?.data?.pagination?.total_count ?? gr?.pagination?.total_count ?? null
  if (grTotal != null) {
    const updatedAt = gr?.data?.updated_at ?? gr?.updated_at ?? null
    return {
      provider: 'goldrush',
      chainIdentifier: typeof gr?.__chainUsed === 'string' ? gr.__chainUsed : null,
      providerUpdatedAt: typeof updatedAt === 'string' && updatedAt.trim() ? updatedAt : null,
      providerTotal: numericTotal(grTotal),
    }
  }
  const moralisTotal = (moralisRaw as HolderTotalResponse)?.total ?? null
  if (moralisTotal != null) {
    return { provider: 'moralis', chainIdentifier: null, providerUpdatedAt: null, providerTotal: numericTotal(moralisTotal) }
  }
  return { provider: null, chainIdentifier: null, providerUpdatedAt: null, providerTotal: null }
}
