// EARLY BUYERS — one structured log line and diagnostic headers per API request.
//
// The line is built from an explicit allowlist of fields, never by spreading a request, a user, an
// error or an EarlyBuyerIntel. It carries only public identifiers (chain, token contract) and
// counts/codes: no auth headers, user ids, emails, plan names beyond free/paid, wallet addresses,
// balances, evidence rows or error messages (provider errors can contain RPC URLs with API keys).
// Every function here swallows its own failures so logging can never break a response.

import type { EarlyBuyerIntel } from './types'

export const EARLY_BUYERS_REQUEST_ID_HEADER = 'x-early-buyers-request-id'
export const EARLY_BUYERS_SOURCE_HEADER = 'x-early-buyers-source'

export type EarlyBuyerRequestSource =
  | 'durable_kv' | 'provisional_kv' | 'supabase' | 'cold_scan' | 'none'
  | 'shared_wait_durable_kv' | 'shared_wait_provisional_kv' | 'shared_wait_supabase'
  | 'quota_rejected' | 'unauthorized' | 'invalid_request' | 'unsupported_chain' | 'error'

export type EarlyBuyerRequestLog = {
  requestId: string
  status: number
  source: EarlyBuyerRequestSource
  durationMs: number
  chain?: string | null
  token?: string | null
  access?: 'anonymous' | 'free' | 'paid'
  holdingsSource?: string | null
  rejection?: string | null
  errorCode?: string | null
  intel?: EarlyBuyerIntel | null
}

const ADDRESS = /^0x[0-9a-f]{40}$/
const CODE = /^[a-z0-9_]{1,64}$/
const code = (v: unknown): string | null => (typeof v === 'string' && CODE.test(v) ? v : null)
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

export function newEarlyBuyerRequestId(): string {
  try { return crypto.randomUUID() } catch { return `eb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }
}

/** The JSON object that gets logged. Exported for tests. */
export function earlyBuyerLogRecord(entry: EarlyBuyerRequestLog): Record<string, unknown> {
  const i = entry.intel
  const reasons = i ? [...new Set(i.coverage.reasons.flatMap((r) => String(r).split(',')).map((r) => r.trim()))].map(code).filter((r): r is string => r != null).slice(0, 10) : []
  return {
    evt: 'early_buyers_request',
    requestId: typeof entry.requestId === 'string' ? entry.requestId.slice(0, 64) : null,
    status: count(entry.status),
    source: code(entry.source),
    durationMs: count(Math.round(entry.durationMs)),
    chain: entry.chain === 'base' || entry.chain === 'eth' ? entry.chain : entry.chain == null ? null : 'other',
    // Public token contract address only; anything else is dropped.
    token: typeof entry.token === 'string' && ADDRESS.test(entry.token) ? entry.token : null,
    access: entry.access ?? null,
    holdingsSource: code(entry.holdingsSource),
    rejection: code(entry.rejection),
    errorCode: code(entry.errorCode),
    evidenceStatus: code(i?.evidenceStatus ?? i?.status),
    holdingsStatus: code(i?.holdingsStatus),
    rpcCalls: count(i?.budget.calls),
    estimatedCu: count(i?.budget.cu),
    blockReceiptCalls: count(i?.budget.blockReceiptCalls),
    receiptsInspected: count(i?.window.examined?.receipts),
    swapTransactions: count(i?.window.examined?.swapTransactions),
    recipients: i ? count(i.buyers.length) : null,
    capped: i ? i.coverage.capped === true : null,
    coverageReasons: reasons,
  }
}

/** Writes one JSON line. Never throws. */
export function logEarlyBuyerRequest(entry: EarlyBuyerRequestLog, sink: (line: string) => void = (line) => console.info(line)): void {
  let line: string | null = null
  // A malformed result still gets a request line, just without its result fields.
  try { line = JSON.stringify(earlyBuyerLogRecord(entry)) } catch { try { line = JSON.stringify(earlyBuyerLogRecord({ ...entry, intel: null })) } catch { line = null } }
  if (line == null) return
  try { sink(line) } catch { /* logging must never break the request */ }
}

/** Adds request id, source and Server-Timing headers. Never throws; returns the same response. */
export function withEarlyBuyerDiagnostics<R extends Response>(response: R, entry: Pick<EarlyBuyerRequestLog, 'requestId' | 'source' | 'durationMs' | 'holdingsSource'>): R {
  try {
    response.headers.set(EARLY_BUYERS_REQUEST_ID_HEADER, entry.requestId)
    const holdings = code(entry.holdingsSource)
    response.headers.set(EARLY_BUYERS_SOURCE_HEADER, `${code(entry.source) ?? 'unknown'}${holdings ? `; holdings=${holdings}` : ''}`)
    response.headers.set('Server-Timing', `eb;dur=${Math.max(0, Math.round(entry.durationMs))};desc="${code(entry.source) ?? 'unknown'}"`)
  } catch { /* immutable or unusual response headers: return it unchanged */ }
  return response
}
