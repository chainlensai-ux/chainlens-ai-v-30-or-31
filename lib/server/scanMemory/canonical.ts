/** Pure evidence identity for CORTEX memory. No I/O and no previous-row reads. */
import { createHash } from 'node:crypto'
import { TOKEN_RISK_METHODOLOGY_VERSION } from '../riskScore'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from '../tokenPublicResponse'

export const SCAN_MEMORY_VERSION = 1
export const SCAN_MEMORY_DAILY_CAP = 2_000
export const SCAN_MEMORY_SCANNER_VERSION = `token_scanner_response:${TOKEN_SCAN_RESPONSE_SCHEMA_VERSION}`
export const SCAN_MEMORY_METHODOLOGY_VERSION = TOKEN_RISK_METHODOLOGY_VERSION
const UNIT = '\x1f'

export const RISK_INPUT_KEYS = [
  'marketMaturity', 'liquiditySafety', 'contractSafety', 'behavioralRisk',
  'marketCap', 'liquidity', 'holders', 'lpControl', 'simulation',
] as const

export type RiskInputKey = typeof RISK_INPUT_KEYS[number]
export type RiskInputStatus = 'verified' | 'partial' | 'unavailable'
export type ScanMemoryCoverage = 'complete' | 'partial' | 'provider_unavailable'

export type ScanMemoryEvidence = {
  chain: 'base' | 'eth' | 'bnb' | 'robinhood'
  tokenAddress: string
  scannerVersion: string
  riskMethodologyVersion: string
  coverage: ScanMemoryCoverage
  coverageReason: 'market' | 'simulation' | 'holders' | 'lp' | 'partial_section' | null
  riskScore: number
  holderPoints: number | null
  holderBasis: string | null
  liquidityBand: number | null
  honeypot: '1' | '0' | '-'
  mint: string
  blacklist: string
  pause: string
  lpStatus: string
  devStatus: string
  riskInputs: Record<RiskInputKey, RiskInputStatus>
}

/** Largest n where (11/10)^n <= cents. Exact powers stay in band n. Null is not band 0. */
export function liquidityBandFromCents(cents: bigint): number | null {
  if (cents < BigInt(1)) return null
  let n = 0
  let pow11 = BigInt(1)
  let pow10 = BigInt(1)
  const eleven = BigInt(11)
  const ten = BigInt(10)
  while (n < 500) {
    const next11 = pow11 * eleven
    const next10 = pow10 * ten
    if (next11 > cents * next10) break
    pow11 = next11
    pow10 = next10
    n += 1
  }
  return n
}

/** Cent rounding shared with SQL `trunc(numeric * 100)`. Sub-cent and non-positive values are missing. */
export function usdToCents(usd: number): bigint | null {
  if (!Number.isFinite(usd) || usd <= 0 || usd > 1e15) return null
  const cents = Math.trunc(usd * 100 + 1e-8)
  if (!Number.isSafeInteger(cents) || cents < 1) return null
  return BigInt(cents)
}

export function centsToUsdString(cents: bigint): string {
  const whole = cents / BigInt(100)
  const frac = cents % BigInt(100)
  return `${whole.toString()}.${frac.toString().padStart(2, '0')}`
}

export function holderPoints(top10: number): number | null {
  if (!Number.isFinite(top10) || top10 < 0 || top10 > 100) return null
  const nearest = Math.round(top10)
  if (Math.abs(top10 - nearest) < 1e-8) return nearest
  return Math.floor(top10)
}

export function canonicalScanMemory(evidence: ScanMemoryEvidence): string {
  const parts = [
    '1',
    evidence.chain,
    evidence.tokenAddress,
    evidence.scannerVersion,
    evidence.riskMethodologyVersion,
    evidence.coverage,
    evidence.coverageReason ?? '-',
    String(evidence.riskScore),
    evidence.holderPoints == null ? '-' : String(evidence.holderPoints),
    evidence.holderBasis ?? '-',
    evidence.liquidityBand == null ? '-' : String(evidence.liquidityBand),
    evidence.honeypot,
    evidence.mint,
    evidence.blacklist,
    evidence.pause,
    evidence.lpStatus,
    evidence.devStatus,
    RISK_INPUT_KEYS.map((key) => evidence.riskInputs[key]).join(','),
  ]
  if (parts.some((part) => part.includes(UNIT) || part.includes('\n') || part.includes('\r'))) {
    throw new Error('scan_memory_canonical_separator')
  }
  return parts.join(UNIT)
}

export function hashScanMemory(evidence: ScanMemoryEvidence): string {
  return createHash('sha256').update(canonicalScanMemory(evidence), 'utf8').digest('hex')
}
