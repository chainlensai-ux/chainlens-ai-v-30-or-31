// lib/holderProviderDiagnostics.ts — per-provider holder diagnostics for the Token Scanner's holder
// DEBUG output only (pure; no I/O). Public holder behavior never reads this.
//
// Base / ETH holders come from GoldRush token_holders_v2 (primary) and Moralis /erc20/{token}/owners
// (fallback, consulted only when GoldRush yields no usable rows). When both yield nothing the Holder
// Map shows "not returned", and before this the Moralis leg left no trace at all. This summarises
// each provider from the markers the fetchers already attach (HTTP status, timeout flag) — never an
// API key, a header, or a raw response body. Row counts here are sample sizes, never holder counts.

export type HolderProviderName = 'goldrush' | 'moralis'

export type HolderProviderStatusCategory =
  | 'ok'
  | 'empty'
  | 'http_4xx'
  | 'http_5xx'
  | 'timeout'
  | 'network_error'
  | 'not_configured'
  | 'unknown'

export type HolderProviderDiagnostic = {
  provider: HolderProviderName
  /** A request was made (false when the provider is not configured for this chain). */
  attempted: boolean
  /** The holder resolver actually read this provider's rows (Moralis only when GoldRush had none). */
  consulted: boolean
  statusCategory: HolderProviderStatusCategory
  httpStatus: number | null
  timedOut: boolean
  /** Rows in the provider response (a sample size, never a holder count). */
  rowsReturned: number
  /** The provider's own total holder count, when it reported one. */
  providerTotal: number | null
  /** Rows left after normalization (address checks, token/infra exclusions); null = not evaluated. */
  usableRows: number | null
  /** Safe fixed reason code. */
  reason: string
}

type Raw = Record<string, unknown> | null | undefined

const finiteInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

/** True for the fetch abort a per-request timeout produces (AbortSignal.timeout / AbortController). */
export function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

function rowsOf(provider: HolderProviderName, raw: Raw): number {
  if (!raw) return 0
  if (provider === 'moralis') return Array.isArray(raw.result) ? raw.result.length : 0
  const data = raw.data as Record<string, unknown> | undefined
  return Array.isArray(data?.items) ? (data!.items as unknown[]).length : Array.isArray(raw.items) ? (raw.items as unknown[]).length : 0
}

function totalOf(provider: HolderProviderName, raw: Raw): number | null {
  if (!raw) return null
  if (provider === 'moralis') return finiteInt(raw.total)
  const data = raw.data as Record<string, unknown> | undefined
  const pag = (data?.pagination ?? raw.pagination) as Record<string, unknown> | undefined
  return finiteInt(pag?.total_count)
}

export function describeHolderProvider(provider: HolderProviderName, raw: Raw, opts: { usableRows: number | null; consulted: boolean }): HolderProviderDiagnostic {
  const status = raw?.__status
  const httpStatus = finiteInt(provider === 'moralis' ? raw?.__httpStatus : raw?.__statusCode)
  const timedOut = raw?.__timedOut === true
  const rowsReturned = rowsOf(provider, raw)
  const base = { provider, consulted: opts.consulted, httpStatus, timedOut, rowsReturned, providerTotal: totalOf(provider, raw), usableRows: opts.usableRows }
  if (!raw || status === 'not_configured') {
    const why = typeof raw?.__reason === 'string' && /^(missing_api_key|chain_not_supported)$/.test(raw.__reason) ? raw.__reason : 'not_configured'
    return { ...base, attempted: false, statusCategory: 'not_configured', reason: why }
  }
  if (status === 'error') {
    const statusCategory: HolderProviderStatusCategory = timedOut ? 'timeout'
      : httpStatus == null ? 'network_error'
      : httpStatus >= 500 ? 'http_5xx'
      : httpStatus >= 400 ? 'http_4xx'
      : 'unknown'
    return { ...base, attempted: true, statusCategory, reason: timedOut ? 'timeout' : httpStatus != null ? `http_${httpStatus}` : 'network_error' }
  }
  if (rowsReturned === 0) return { ...base, attempted: true, statusCategory: 'empty', reason: 'no_rows_returned' }
  if (opts.usableRows === 0) return { ...base, attempted: true, statusCategory: 'ok', reason: 'no_usable_rows_after_normalization' }
  return { ...base, attempted: true, statusCategory: 'ok', reason: opts.usableRows == null ? 'rows_returned_not_consulted' : 'ok' }
}

/** One-line debug summary, e.g. "timeout · attempted · rows 0 · usable — · total — · consulted". */
export function formatHolderProviderDiagnostic(d: HolderProviderDiagnostic | null | undefined): string {
  if (!d) return '—'
  return [
    d.reason,
    d.attempted ? `attempted${d.httpStatus != null ? ` HTTP ${d.httpStatus}` : ''}` : 'not attempted',
    d.timedOut ? 'timed out' : null,
    `rows ${d.rowsReturned}`,
    `usable ${d.usableRows ?? '—'}`,
    `total ${d.providerTotal ?? '—'}`,
    d.consulted ? 'consulted' : 'not consulted',
  ].filter(Boolean).join(' · ')
}
