// lib/pricing/poolMath.ts — pure AMM pool math for CURRENT on-chain pricing (no I/O).
//
// REUSE AUDIT: the only existing on-chain pool math (src/modules/pricingAtTimeEngine/sources/basedex.ts)
// is embedded inside block-pinned, Base-only, historical readers with their own caches and RPC budget, so
// it cannot be called for a current price. These are the same textbook formulas, isolated and testable:
//   - V2 (constant product): price = reserveQuote / reserveToken (decimal-adjusted).
//   - V3 / V4 (concentrated): price(token1 per token0) = (sqrtPriceX96 / 2^96)^2 * 10^(dec0 - dec1).
// Every function returns null — never a guess — on zero/negative/malformed state.

export type PoolPriceInput = {
  tokenIsToken0: boolean
  tokenDecimals: number
  quoteDecimals: number
}

const Q96 = 2 ** 96

function validDecimals(d: number): boolean {
  return Number.isInteger(d) && d >= 0 && d <= 36
}

function finitePositive(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null
}

/** V2: price of the token in quote units from raw reserves (bigint or decimal string). */
export function v2PriceInQuote(reserve0: bigint, reserve1: bigint, input: PoolPriceInput): number | null {
  if (!validDecimals(input.tokenDecimals) || !validDecimals(input.quoteDecimals)) return null
  if (reserve0 <= BigInt(0) || reserve1 <= BigInt(0)) return null
  const [tokenRaw, quoteRaw] = input.tokenIsToken0 ? [reserve0, reserve1] : [reserve1, reserve0]
  const token = Number(tokenRaw) / 10 ** input.tokenDecimals
  const quote = Number(quoteRaw) / 10 ** input.quoteDecimals
  return finitePositive(quote / token)
}

/** V2: the quote side's human-unit reserve (for liquidity evidence). */
export function v2QuoteReserve(reserve0: bigint, reserve1: bigint, input: PoolPriceInput): number | null {
  if (!validDecimals(input.quoteDecimals)) return null
  const quoteRaw = input.tokenIsToken0 ? reserve1 : reserve0
  if (quoteRaw <= BigInt(0)) return null
  return finitePositive(Number(quoteRaw) / 10 ** input.quoteDecimals)
}

/** V3/V4: price of the token in quote units from sqrtPriceX96. */
export function sqrtPriceX96ToPriceInQuote(sqrtPriceX96: bigint, input: PoolPriceInput): number | null {
  if (!validDecimals(input.tokenDecimals) || !validDecimals(input.quoteDecimals)) return null
  if (sqrtPriceX96 <= BigInt(0)) return null
  const sqrt = Number(sqrtPriceX96) / Q96
  const rawToken1PerToken0 = sqrt * sqrt
  if (!Number.isFinite(rawToken1PerToken0) || rawToken1PerToken0 <= 0) return null
  const [dec0, dec1] = input.tokenIsToken0 ? [input.tokenDecimals, input.quoteDecimals] : [input.quoteDecimals, input.tokenDecimals]
  const token1PerToken0 = rawToken1PerToken0 * 10 ** (dec0 - dec1)
  return finitePositive(input.tokenIsToken0 ? token1PerToken0 : 1 / token1PerToken0)
}

/**
 * V4 (or V3 without a balance read): the quote side's in-range VIRTUAL reserve from active liquidity L —
 * token1 = L * sqrtP, token0 = L / sqrtP (raw units). A lower bound on what the active range can absorb,
 * used only as liquidity evidence.
 */
export function concentratedVirtualQuoteReserve(liquidity: bigint, sqrtPriceX96: bigint, input: PoolPriceInput): number | null {
  if (!validDecimals(input.quoteDecimals)) return null
  if (liquidity <= BigInt(0) || sqrtPriceX96 <= BigInt(0)) return null
  const sqrt = Number(sqrtPriceX96) / Q96
  const L = Number(liquidity)
  const quoteIsToken1 = input.tokenIsToken0
  const quoteRaw = quoteIsToken1 ? L * sqrt : L / sqrt
  return finitePositive(quoteRaw / 10 ** input.quoteDecimals)
}
