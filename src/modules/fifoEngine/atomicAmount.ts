// FIFO atomic-unit amount arithmetic.
//
// CONFIRMED PRODUCTION BUG, DISCLOSED (10 Base USDC candidate-only lots): matchLotsFIFO did
// `lot.amountRemaining -= amountFromThisLot` and `remainingToMatch -= amountFromThisLot` in IEEE
// floats, then treated `amountRemaining > 0` as economic inventory. For Base USDC (6 decimals,
// 1 atomic unit = 1e-6) that leftover is ~1e-12 / 0 — smaller than one atomic unit, impossible
// on-chain, and still `isCanonicalVerifiedPublishedLot` because 9e-13 USD > 0.
//
// HARD INVARIANT: for an ERC20 with decimals=d, an economic FIFO lot amount must map to an
// integer number of atomic units (amount * 10^d ∈ integers in canonical decimal representation).
// Residuals below 1 atomic unit must not become matched lots. 18-decimal tokens keep 1-wei lots.

import { resolveTokenDecimals } from '../normalization/canonicalDecimals'

export function tokenCanonicalDecimals(chain: string, token: string, providerDecimals?: number | null): number {
  return resolveTokenDecimals({ chain, token, providerDecimals }).decimals
}

export function minimumAtomicAmount(decimals: number): number {
  const d = clampDecimals(decimals)
  return Number(`1e-${d}`)
}

function clampDecimals(decimals: number): number {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18
}

export function numberToAtomicUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return BigInt(0)
  const d = clampDecimals(decimals)
  const fixed = amount.toFixed(d)
  const [whole, frac = ''] = fixed.split('.')
  const fracPadded = (frac + '0'.repeat(d)).slice(0, d)
  const wholeAtomic = BigInt(whole) * (BigInt(10) ** BigInt(d))
  return d === 0 ? wholeAtomic : wholeAtomic + BigInt(fracPadded || '0')
}

export function atomicUnitsToNumber(atomic: bigint, decimals: number): number {
  if (atomic === BigInt(0)) return 0
  const d = clampDecimals(decimals)
  const scale = BigInt(10) ** BigInt(d)
  const sign = atomic < BigInt(0) ? -1 : 1
  const abs = atomic < BigInt(0) ? -atomic : atomic
  const whole = abs / scale
  const frac = abs % scale
  if (d === 0) return sign * Number(whole)
  return sign * Number(`${whole.toString()}.${frac.toString().padStart(d, '0')}`)
}

export function amountInAtomicUnits(amount: number, decimals: number): bigint {
  return numberToAtomicUnits(amount, decimals)
}

export function isIntegerAtomicUnits(amount: number, decimals: number): boolean {
  if (!Number.isFinite(amount) || amount < 0) return false
  if (amount === 0) return true
  const atomic = numberToAtomicUnits(amount, decimals)
  if (atomic === BigInt(0)) return false
  return atomicUnitsToNumber(atomic, decimals) === amount
}

export function isEconomicAtomicLotAmount(amount: number, decimals: number): boolean {
  return numberToAtomicUnits(amount, decimals) >= BigInt(1)
}

export type FifoAtomicAmountAudit = {
  normalizedAmount: number
  canonicalTokenDecimals: number
  minimumAtomicAmount: number
  amountInAtomicUnits: string
  isIntegerAtomicUnits: boolean
  economicLot: boolean
}

export function auditAtomicLotAmount(amount: number, decimals: number): FifoAtomicAmountAudit {
  const atomic = numberToAtomicUnits(amount, decimals)
  return {
    normalizedAmount: amount,
    canonicalTokenDecimals: decimals,
    minimumAtomicAmount: minimumAtomicAmount(decimals),
    amountInAtomicUnits: atomic.toString(),
    isIntegerAtomicUnits: isIntegerAtomicUnits(amount, decimals),
    economicLot: atomic >= BigInt(1),
  }
}
