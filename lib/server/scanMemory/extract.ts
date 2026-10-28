/**
 * Allowlisted snapshot of a completed EVM token scan.
 * Reads only named fields from the server-built response. Never copies the response body.
 */
import {
  RISK_INPUT_KEYS, SCAN_MEMORY_METHODOLOGY_VERSION, SCAN_MEMORY_SCANNER_VERSION,
  centsToUsdString, hashScanMemory, holderPoints, liquidityBandFromCents, usdToCents,
  type RiskInputKey, type RiskInputStatus, type ScanMemoryCoverage, type ScanMemoryEvidence,
} from './canonical'

const CHAINS = new Set(['base', 'eth', 'bnb', 'robinhood'])
const FLAGS = new Set(['verified', 'possible', 'not_detected', 'inferred', 'partial', 'unavailable'])
const LP = new Set(['burned', 'locked', 'unlocked', 'protocol', 'team_controlled', 'wallet_controlled', 'concentrated_liquidity', 'partial', 'no_pool', 'open_check', 'insufficient_data', 'error', 'unavailable'])
const DEV = new Set(['confirmed', 'possible_match', 'not_confirmed', 'unavailable'])
const INPUTS = new Set<RiskInputStatus>(['verified', 'partial', 'unavailable'])
const FAILURES = new Set(['market', 'simulation', 'holders', 'lp'])
const LABELS = new Set(['Low Risk', 'Moderate Risk', 'Caution', 'High Risk', 'Extreme Risk'])
const BASIS = /^(provider_reported_percent|total_supply:[a-z0-9_]{1,40})$/
const ADDRESS = /0x[0-9a-fA-F]{40}/

export type ScanMemorySkipReason =
  | 'non_evm' | 'invalid_token' | 'scanner_mismatch' | 'methodology_mismatch'
  | 'invalid_signal' | 'invalid_observed_at'

export type ScanMemoryPayload = {
  chain: ScanMemoryEvidence['chain']
  token_address: string
  scanner_version: string
  risk_methodology_version: string
  coverage: ScanMemoryCoverage
  coverage_reason: ScanMemoryEvidence['coverageReason']
  risk_score: number
  risk_label: string | null
  price_usd: string | null
  liquidity_usd: string | null
  market_cap_usd: string | null
  holder_points: number | null
  holder_basis: string | null
  observed_at: string
  honeypot: '1' | '0' | '-'
  mint: string
  blacklist: string
  pause: string
  lp_status: string
  dev_status: string
  risk_inputs: Record<RiskInputKey, RiskInputStatus>
  evidence_hash: string
}

export type ExtractResult =
  | { ok: true; payload: ScanMemoryPayload }
  | { ok: false; reason: ScanMemorySkipReason }

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function closed(value: unknown, allowed: Set<string>, missing: string): string | null {
  if (value == null || value === '') return missing
  if (typeof value !== 'string' || !allowed.has(value)) return null
  return value
}

function money(value: unknown): string | null | undefined {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return undefined
  if (n <= 0) return null
  const cents = usdToCents(n)
  return cents == null ? null : centsToUsdString(cents)
}

export function extractScanMemory(scan: unknown, nowMs = Date.now()): ExtractResult {
  const row = record(scan)
  if (!row) return { ok: false, reason: 'invalid_signal' }
  const chain = row.chain
  if (typeof chain !== 'string' || !CHAINS.has(chain)) return { ok: false, reason: 'non_evm' }
  const token = typeof row.contract === 'string' ? row.contract.toLowerCase() : ''
  if (!/^0x[0-9a-f]{40}$/.test(token)) return { ok: false, reason: 'invalid_token' }
  if (row.scanResponseSchemaVersion !== undefined && row.scanResponseSchemaVersion !== Number(SCAN_MEMORY_SCANNER_VERSION.split(':')[1])) {
    return { ok: false, reason: 'scanner_mismatch' }
  }
  if (row.scanResponseSchemaVersion == null) return { ok: false, reason: 'scanner_mismatch' }
  if (row.riskMethodologyVersion !== SCAN_MEMORY_METHODOLOGY_VERSION) return { ok: false, reason: 'methodology_mismatch' }
  if (typeof row.riskScore !== 'number' || !Number.isInteger(row.riskScore) || row.riskScore < 0 || row.riskScore > 100) {
    return { ok: false, reason: 'invalid_signal' }
  }
  const started = row.scanRequestStartedAt
  if (typeof started !== 'number' || !Number.isFinite(started)) return { ok: false, reason: 'invalid_observed_at' }
  if (started > nowMs + 5 * 60_000 || started < nowMs - 6 * 60 * 60_000) return { ok: false, reason: 'invalid_observed_at' }

  const inputs = record(row.riskInputStatuses)
  if (!inputs) return { ok: false, reason: 'invalid_signal' }
  const riskInputs = {} as Record<RiskInputKey, RiskInputStatus>
  for (const key of RISK_INPUT_KEYS) {
    const status = inputs[key]
    if (typeof status !== 'string' || !INPUTS.has(status as RiskInputStatus)) return { ok: false, reason: 'invalid_signal' }
    riskInputs[key] = status as RiskInputStatus
  }
  const failure = record(row.tokenScannerPipelineAudit)?.firstFailureStage ?? null
  let coverage: ScanMemoryCoverage
  let coverageReason: ScanMemoryEvidence['coverageReason']
  if (failure != null) {
    if (typeof failure !== 'string' || !FAILURES.has(failure)) return { ok: false, reason: 'invalid_signal' }
    coverage = 'provider_unavailable'
    coverageReason = failure as ScanMemoryEvidence['coverageReason']
  } else if (RISK_INPUT_KEYS.some((key) => riskInputs[key] !== 'verified')) {
    coverage = 'partial'
    coverageReason = 'partial_section'
  } else {
    coverage = 'complete'
    coverageReason = null
  }

  const flags = record(row.contractFlags)
  const mint = closed(record(flags?.mint)?.status, FLAGS, 'unavailable')
  const blacklist = closed(record(flags?.blacklist)?.status, FLAGS, 'unavailable')
  const pause = closed(record(flags?.pause)?.status, FLAGS, 'unavailable')
  if (!mint || !blacklist || !pause) return { ok: false, reason: 'invalid_signal' }
  const lpStatus = closed(record(row.lpControl)?.status, LP, 'unavailable')
  const devStatus = closed(record(row.devIntel)?.deployerStatus, DEV, 'unavailable')
  if (!lpStatus || !devStatus) return { ok: false, reason: 'invalid_signal' }

  const honeypot = record(row.honeypot)
  const isHoneypot = honeypot?.isHoneypot
  const honeypotCode: '1' | '0' | '-' = isHoneypot === true ? '1' : isHoneypot === false ? '0' : '-'
  if (isHoneypot != null && honeypotCode === '-') return { ok: false, reason: 'invalid_signal' }

  const holders = record(row.holderDistribution)
  let holderPointsValue: number | null = null
  if (holders?.top10 != null) {
    if (typeof holders.top10 !== 'number') return { ok: false, reason: 'invalid_signal' }
    holderPointsValue = holderPoints(holders.top10)
    if (holderPointsValue == null) return { ok: false, reason: 'invalid_signal' }
  }
  let holderBasis: string | null = null
  if (holders?.denominator != null) {
    if (typeof holders.denominator !== 'string' || !BASIS.test(holders.denominator)) return { ok: false, reason: 'invalid_signal' }
    holderBasis = holders.denominator
  }

  const price = money(row.priceUsd)
  const liquidity = money(row.liquidityUsd)
  const marketCap = money(row.marketCapUsd)
  if (price === undefined || liquidity === undefined || marketCap === undefined) return { ok: false, reason: 'invalid_signal' }
  const liquidityBand = liquidity == null ? null : liquidityBandFromCents(usdToCents(Number(liquidity))!)

  const evidence: ScanMemoryEvidence = {
    chain: chain as ScanMemoryEvidence['chain'],
    tokenAddress: token,
    scannerVersion: SCAN_MEMORY_SCANNER_VERSION,
    riskMethodologyVersion: SCAN_MEMORY_METHODOLOGY_VERSION,
    coverage, coverageReason, riskScore: row.riskScore,
    holderPoints: holderPointsValue, holderBasis, liquidityBand,
    honeypot: honeypotCode, mint, blacklist, pause, lpStatus, devStatus, riskInputs,
  }
  const payload: ScanMemoryPayload = {
    chain: evidence.chain,
    token_address: token,
    scanner_version: evidence.scannerVersion,
    risk_methodology_version: evidence.riskMethodologyVersion,
    coverage, coverage_reason: coverageReason,
    risk_score: row.riskScore,
    risk_label: typeof row.riskLabel === 'string' && LABELS.has(row.riskLabel) ? row.riskLabel : null,
    price_usd: price, liquidity_usd: liquidity, market_cap_usd: marketCap,
    holder_points: holderPointsValue, holder_basis: holderBasis,
    observed_at: new Date(started).toISOString(),
    honeypot: honeypotCode, mint, blacklist, pause, lp_status: lpStatus, dev_status: devStatus,
    risk_inputs: riskInputs,
    evidence_hash: hashScanMemory(evidence),
  }
  const encoded = JSON.stringify({ ...payload, token_address: 'token' })
  if (ADDRESS.test(encoded)) return { ok: false, reason: 'invalid_signal' }
  return { ok: true, payload }
}
