// MODULE — receiptSwapDecoder: Uniswap V3 (Base) pool-leg resolution.
//
// GOAL, DISCLOSED: production proof — a fetched receipt was forensically classified
// `uniswap_v3_like` (1 concentrated-liquidity Swap event, 2 transfers, 1 WETH wrap) and rejected as
// `pool_not_validated_by_factory` purely because factory validation only ever tried the Aerodrome
// Slipstream factory — the exact same Swap event SIGNATURE Uniswap V3 uses (see signatures.ts's own
// header: SLIPSTREAM_SWAP_TOPIC0 is the canonical Uniswap V3 Swap topic0, shared by both forks).
// This module resolves the pool leg from that same signed (amount0, amount1) pair — never re-
// decoding logs, never a new provider call by itself — so index.ts can attempt real Uniswap V3
// factory validation as a fallback once Aerodrome's own validation has genuinely failed.
//
// DO NOT TREAT SLIPSTREAM AS UNISWAP V3, DISCLOSED: this resolver is never the FIRST attempt for a
// concentrated-liquidity Swap event — index.ts only reaches for it after the existing Aerodrome
// Slipstream path (resolvePoolLeg + Aerodrome factory validation) has already failed. Identity is
// decided by WHICH real factory's getPool() confirms the pool, never by topic0 shape alone.
//
// SIGN-BASED RESOLUTION, DISCLOSED: a Uniswap V3 Swap event's (amount0, amount1) is already the
// exact, authoritative SIGNED net flow for the pool (positive = pool received, negative = pool paid
// out) — there is no separate gross In/Out pair to reconcile the way Aerodrome Classic's Swap event
// has (see multiTransferLeg.ts). Exactly one side must be positive (the input) and exactly one
// negative (the output); anything else is a contradiction in the Swap event's own values, never
// guessed at. The ERC20 Transfer logs are used ONLY to identify WHICH token corresponds to which
// side (aggregating same-token transfers that actually touch the validated pool, ignoring every
// transfer that doesn't — router intermediaries, wallet-facing legs, wraps/refunds) and to confirm
// that aggregate matches the Swap event's own absolute amount within a fixed, deterministic
// 1-raw-unit tolerance — never a percentage, never scaled by decimals.

import type { DecodedLogs, DecodedPoolSwap, DecodedTransfer } from './decodeLogs'
import type { UniswapV3Diagnostics } from './types'

export type UniswapV3PoolLeg = {
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
}

export type UniswapV3Resolution =
  | { ok: true; leg: UniswapV3PoolLeg; diagnostics: UniswapV3Diagnostics }
  | {
      ok: false
      reason: 'uniswap_v3_sign_ambiguous' | 'uniswap_v3_ambiguous_token_mapping' | 'uniswap_v3_amount_mismatch'
      diagnostics: UniswapV3Diagnostics
    }

const RAW_UNIT_TOLERANCE = BigInt('1')

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

function sumByToken(transfers: DecodedTransfer[]): Map<string, bigint> {
  const sums = new Map<string, bigint>()
  for (const t of transfers) sums.set(t.token, (sums.get(t.token) ?? BigInt('0')) + t.value)
  return sums
}

// PURE, offline — no provider calls, no I/O. `swap` must be the pool's raw decoded Swap event
// (amount0/amount1 already the exact signed net values decodeLogs.ts computed from the log data);
// `decoded` is the same in-memory decodeLogs.ts output already computed for this receipt.
export function resolveUniswapV3Leg(swap: DecodedPoolSwap, decoded: DecodedLogs): UniswapV3Resolution {
  const pool = swap.poolAddress
  const poolTransfers = decoded.transfers.filter((t) => t.to === pool || t.from === pool)
  const routerIntermediaryTransfersIgnored = decoded.transfers.length - poolTransfers.length

  const diagnosticsBase: UniswapV3Diagnostics = {
    examined: true,
    resolved: false,
    signValid: null,
    amountMatched: null,
    routerIntermediaryTransfersIgnored,
  }

  const zero = BigInt('0')
  const positiveCount = (swap.amount0 > zero ? 1 : 0) + (swap.amount1 > zero ? 1 : 0)
  const negativeCount = (swap.amount0 < zero ? 1 : 0) + (swap.amount1 < zero ? 1 : 0)

  // EXACTLY ONE POSITIVE, ONE NEGATIVE, DISCLOSED: anything else (both positive, both negative,
  // either zero) is a contradiction in the Swap event's own reported amounts — never guessed at.
  if (positiveCount !== 1 || negativeCount !== 1) {
    return { ok: false, reason: 'uniswap_v3_sign_ambiguous', diagnostics: { ...diagnosticsBase, signValid: false } }
  }

  const inAmount = swap.amount0 > zero ? swap.amount0 : swap.amount1
  const outAmount = swap.amount0 < zero ? -swap.amount0 : -swap.amount1

  const incoming = poolTransfers.filter((t) => t.to === pool)
  const outgoing = poolTransfers.filter((t) => t.from === pool)
  const incomingByToken = sumByToken(incoming)
  const outgoingByToken = sumByToken(outgoing)

  const inMatches = [...incomingByToken.entries()].filter(([, sum]) => absDiff(sum, inAmount) <= RAW_UNIT_TOLERANCE)
  const outMatches = [...outgoingByToken.entries()].filter(([, sum]) => absDiff(sum, outAmount) <= RAW_UNIT_TOLERANCE)

  // AMBIGUOUS TOKEN MAPPING, DISCLOSED: no candidate token on a side at all, or more than one
  // token's aggregate happens to land within tolerance — never picked arbitrarily.
  if (incomingByToken.size === 0 || outgoingByToken.size === 0 || inMatches.length > 1 || outMatches.length > 1) {
    return { ok: false, reason: 'uniswap_v3_ambiguous_token_mapping', diagnostics: { ...diagnosticsBase, signValid: true, amountMatched: false } }
  }

  // A token exists on this side but its aggregate doesn't land within tolerance of the Swap event's
  // own amount — a real mismatch, never silently accepted.
  if (inMatches.length !== 1 || outMatches.length !== 1) {
    return { ok: false, reason: 'uniswap_v3_amount_mismatch', diagnostics: { ...diagnosticsBase, signValid: true, amountMatched: false } }
  }

  const [tokenIn] = inMatches[0]
  const [tokenOut] = outMatches[0]
  if (tokenIn === tokenOut) {
    return { ok: false, reason: 'uniswap_v3_ambiguous_token_mapping', diagnostics: { ...diagnosticsBase, signValid: true, amountMatched: false } }
  }

  return {
    ok: true,
    leg: { tokenIn, tokenOut, amountIn: inAmount, amountOut: outAmount },
    diagnostics: { ...diagnosticsBase, resolved: true, signValid: true, amountMatched: true },
  }
}
