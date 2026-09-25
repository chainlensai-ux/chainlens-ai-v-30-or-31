// TOKEN SCANNER HOLDER COUNT HONESTY — DISCLOSED.
// 0, unavailable, capped, and not-attempted must never look the same.
// A provider total is exact only when the reason says so, and "exact" means exact
// PROVIDER-REPORTED total, not a verified chain census (see HolderCountBasis). Partial indexed rows
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
  /** Exact PROVIDER-REPORTED total (not a row count). Not an independently verified chain census. */
  exact: boolean
  /** Evidence basis of an exact provider total, when known. */
  holderCountBasis?: HolderCountBasis | null
  /** Tooltip / footnote qualifying the count, when the basis is weaker than a documented snapshot chain. */
  note?: string | null
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
  /** From holderCountProvenance.holderCountBasis. Only changes wording, never the count. */
  holderCountBasis?: HolderCountBasis | null
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
    // Wording only: a total from an undocumented/unverified provider chain is labelled
    // "Provider total" so it never reads as a verified chain census. The number is unchanged.
    const basis = input.holderCountBasis ?? null
    const weakBasis = basis === 'provider_total_unsupported_chain' || basis === 'provider_total_support_unverified'
    return {
      display: weakBasis ? `${count!.toLocaleString()} · Provider total` : count!.toLocaleString(),
      exact: true,
      holderCountBasis: basis,
      note: weakBasis ? PROVIDER_TOTAL_NOTE : null,
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
 * Where an exact provider holder total came from, and what "exact" is allowed to mean.
 * holderCountExact / HolderCountDisplay.exact mean EXACT PROVIDER-REPORTED TOTAL — the provider's
 * own pagination total for this chain+contract, not a truncated row count. They do NOT mean an
 * independently verified current-chain holder census. How far that provider total can be trusted
 * depends on whether the provider documents holder snapshots for the chain (holderCountBasis).
 * A total with no as-of time cannot be compared against another indexer's figure (e.g. DexScreener):
 * a gap could be index lag, a different counting definition, or neither. This never changes the count.
 */
export type HolderCountBasis =
  /** GoldRush total on a chain GoldRush documents for latest token-holder snapshots (token_holders_v2). */
  | 'provider_total_supported_chain'
  /** GoldRush total on a chain where token_holders_v2 answers but is NOT documented/supported (Robinhood: "frontier" tier). */
  | 'provider_total_unsupported_chain'
  /** Provider total whose chain support/snapshot semantics ChainLens has not verified (e.g. Moralis owners total). */
  | 'provider_total_support_unverified'

/**
 * GoldRush chain identifiers that ChainLens sends to token_holders_v2 AND that GoldRush's
 * token_holders_v2 docs list for the latest token-holders snapshot (Ethereum, Base, BSC).
 * Evidence: ETH ASTEROID GoldRush total matched Ethplorer exactly (2026-09-25).
 */
const GOLDRUSH_SNAPSHOT_DOCUMENTED_CHAIN_IDS = new Set(['eth-mainnet', 'base-mainnet', 'bsc-mainnet'])
/**
 * GoldRush identifiers that answer token_holders_v2 but are not documented for it. Robinhood
 * ('robinhood-mainnet' / '4663') is a GoldRush "frontier" chain whose supported-endpoint list
 * omits token holders. Its total matched Robinhood Blockscout for ICE TEA (374 = 374, 2026-09-25),
 * but GoldRush sources Robinhood explorer data from that same Blockscout, so the match is not
 * independent verification.
 */
const GOLDRUSH_HOLDERS_UNDOCUMENTED_CHAIN_IDS = new Set(['robinhood-mainnet', '4663'])

export function holderCountBasisFor(provider: HolderCountProvenance['provider'], chainIdentifier: string | null): HolderCountBasis | null {
  if (provider == null) return null
  if (provider === 'goldrush' && chainIdentifier) {
    if (GOLDRUSH_SNAPSHOT_DOCUMENTED_CHAIN_IDS.has(chainIdentifier)) return 'provider_total_supported_chain'
    if (GOLDRUSH_HOLDERS_UNDOCUMENTED_CHAIN_IDS.has(chainIdentifier)) return 'provider_total_unsupported_chain'
  }
  return 'provider_total_support_unverified'
}

/** Tooltip / footnote for any provider total that is not on a documented snapshot chain. */
export const PROVIDER_TOTAL_NOTE = 'Exact count reported by provider; provider support/freshness may vary by chain.'

export type HolderCountProvenance = {
  provider: 'goldrush' | 'moralis' | null
  /** GoldRush chain identifier that answered (Robinhood tries 'robinhood-mainnet' then '4663'). */
  chainIdentifier: string | null
  /** What the exact flag means for this count. Always the provider-reported total, never a verified census. */
  exactMeaning: 'exact_provider_reported_total' | null
  /** How much the provider total can be trusted on this chain. See HolderCountBasis. */
  holderCountBasis: HolderCountBasis | null
  /**
   * When the provider generated this response (GoldRush `updated_at`). NOT the age of the
   * provider's holder snapshot or index — that is not proven by this field.
   */
  providerResponseAt: string | null
  /** @deprecated Backward-compatible alias of providerResponseAt (response-generation time, not snapshot freshness). */
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

const EMPTY_PROVENANCE: HolderCountProvenance = {
  provider: null, chainIdentifier: null, exactMeaning: null, holderCountBasis: null,
  providerResponseAt: null, providerUpdatedAt: null, providerTotal: null,
}

export function holderCountProvenance(goldrushRaw: unknown, moralisRaw: unknown): HolderCountProvenance {
  const gr = (goldrushRaw ?? null) as HolderTotalResponse
  const grTotal = gr?.data?.pagination?.total_count ?? gr?.pagination?.total_count ?? null
  if (grTotal != null) {
    const updatedAt = gr?.data?.updated_at ?? gr?.updated_at ?? null
    const responseAt = typeof updatedAt === 'string' && updatedAt.trim() ? updatedAt : null
    const chainIdentifier = typeof gr?.__chainUsed === 'string' ? gr.__chainUsed : null
    return {
      provider: 'goldrush',
      chainIdentifier,
      exactMeaning: 'exact_provider_reported_total',
      holderCountBasis: holderCountBasisFor('goldrush', chainIdentifier),
      providerResponseAt: responseAt,
      providerUpdatedAt: responseAt,
      providerTotal: numericTotal(grTotal),
    }
  }
  const moralisTotal = (moralisRaw as HolderTotalResponse)?.total ?? null
  if (moralisTotal != null) {
    return {
      ...EMPTY_PROVENANCE,
      provider: 'moralis',
      exactMeaning: 'exact_provider_reported_total',
      holderCountBasis: holderCountBasisFor('moralis', null),
      providerTotal: numericTotal(moralisTotal),
    }
  }
  return { ...EMPTY_PROVENANCE }
}
