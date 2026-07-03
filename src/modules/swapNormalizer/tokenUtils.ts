// MODULE — swapNormalizer: token/decimal helper utilities. Pure functions only.

import type { RawTransfer, SwapNormalizerChain, TokenRef } from './types'
import { ZERO_ADDRESS } from './types'

// Real, canonical wrapped-native addresses. base/optimism share the same predeploy address
// (0x4200...0006) because both are OP-stack chains using the same predeploy convention — verified
// against this codebase's own existing use of that address in
// src/modules/pricingAtTimeEngine/sources/basedex.ts (WETH_BASE).
const WRAPPED_NATIVE: Record<SwapNormalizerChain, string> = {
  eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  optimism: '0x4200000000000000000000000000000000000006',
}

export function wrappedNativeAddress(chain: SwapNormalizerChain): string {
  return WRAPPED_NATIVE[chain]
}

export function isWrappedNative(chain: SwapNormalizerChain, address: string | null | undefined): boolean {
  if (!address) return false
  return address.toLowerCase() === WRAPPED_NATIVE[chain]
}

export function isZeroAddress(address: string | null | undefined): boolean {
  return (address ?? '').toLowerCase() === ZERO_ADDRESS
}

// Converts a raw integer-string amount (as returned by every provider in this codebase — GoldRush's
// `delta`, Alchemy's `rawContract.value`) into a human-readable number. Same division approach as
// src/modules/normalization/utils.ts's parseAmount, for consistency with the rest of the codebase.
// Never throws: an unparseable amount resolves to 0, never NaN/undefined, so downstream arithmetic
// (sums, comparisons) stays well-defined.
export function toDecimalAmount(amountRaw: string | null | undefined, decimals: number | null | undefined): number {
  if (amountRaw == null) return 0
  const dec = typeof decimals === 'number' && Number.isFinite(decimals) ? decimals : 18
  const parsed = Number(amountRaw)
  if (!Number.isFinite(parsed)) return 0
  const value = Math.abs(parsed) / Math.pow(10, dec)
  return Number.isFinite(value) ? value : 0
}

export function tokenRefFromTransfer(transfer: RawTransfer): TokenRef {
  return {
    address: transfer.contract.toLowerCase(),
    symbol: transfer.symbol ?? '?',
    decimals: typeof transfer.decimals === 'number' ? transfer.decimals : 18,
  }
}

// Stable, deterministic ordering key — never relies on object insertion order or Map iteration
// order, which is not guaranteed to match input order once a Set/Map is involved.
export function byLogIndex(a: { logIndex: number }, b: { logIndex: number }): number {
  return a.logIndex - b.logIndex
}
