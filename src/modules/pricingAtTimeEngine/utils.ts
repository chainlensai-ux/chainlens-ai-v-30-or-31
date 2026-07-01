// MODULE — pricingAtTimeEngine: helper functions.

import type { PriceSourceFn, PriceSourceUsed, PriceSources } from './types'

// PURE. Validates a value is a real, finite number — never coerces a string/NaN/Infinity into a
// number, and never invents 0 for a missing value (null stays null).
export function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// PURE. price * amount, with null propagating through both directions — a missing price or an
// unparseable amount always yields null, never a partial/guessed figure.
export function multiplyAmount(price: number | null, amountRaw: string): number | null {
  if (price === null) return null
  const amount = safeNumber(Number(amountRaw))
  if (amount === null) return null
  return price * amount
}

// Tries `primary` first, then `fallback` only if primary returned null. Never invents a third
// source and never treats a thrown error as a valid price — either resolves to a real number or
// to 'failed' (price null). This is the only place in the module that awaits caller-supplied,
// potentially-async functions; given the same priceSources responses, its output is deterministic.
export async function resolvePriceForEntry(
  token: string,
  chain: string,
  timestamp: number,
  priceSources: PriceSources,
): Promise<{ price: number | null; source: PriceSourceUsed }> {
  const primaryPrice = await callPriceSource(priceSources.primary, token, chain, timestamp)
  if (primaryPrice !== null) return { price: primaryPrice, source: 'primary' }

  const fallbackPrice = await callPriceSource(priceSources.fallback, token, chain, timestamp)
  if (fallbackPrice !== null) return { price: fallbackPrice, source: 'fallback' }

  return { price: null, source: 'failed' }
}

async function callPriceSource(
  fn: PriceSourceFn,
  token: string,
  chain: string,
  timestamp: number,
): Promise<number | null> {
  try {
    const result = await fn(token, chain as Parameters<PriceSourceFn>[1], timestamp)
    return safeNumber(result)
  } catch {
    // A price source that throws is treated exactly like one that returns null — never a
    // fabricated price, never a crash that takes down the whole pricing pass.
    return null
  }
}
