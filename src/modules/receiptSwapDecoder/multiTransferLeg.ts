// MODULE — receiptSwapDecoder: Aerodrome Classic multi-transfer pool-leg resolution.
//
// GOAL, DISCLOSED: production proof — one examined receipt had likelyRoute: aerodrome_classic,
// aerodromeSwapEventCount: 1, transferCount: 6, wrapCount: 1, and was rejected as
// contradictory_legs purely because index.ts's original resolvePoolLeg required EXACTLY one
// incoming and one outgoing transfer touching the pool. A real router-mediated Classic swap can
// legitimately involve more transfers than that (router intermediaries relaying the same token in
// two hops, a native-ETH wrap leg, a refund of unused input) without the underlying swap being any
// less real or exact.
//
// FIX: resolve the pool's economic legs from the Swap event's own authoritative
// amount0In/amount1In/amount0Out/amount1Out (never netted, never guessed) and use the ERC20
// Transfer logs ONLY to identify which token corresponds to which side — by aggregating every
// same-token transfer that actually touches the validated pool (summing duplicates, ignoring every
// transfer that doesn't touch the pool) and matching that aggregate against the Swap event's
// amount within a strict, deterministic 1-raw-unit tolerance. A transfer that never touches the
// pool (a router forwarding funds to/from the wallet) is evidence about the WALLET's own flow, not
// the pool's — it is never used to resolve the pool leg, only netted separately afterward (wrap/
// refund diagnostics), exactly as required.
//
// FAIL-CLOSED, DISCLOSED: any ambiguity (more than one nonzero side on the Swap event itself, more
// than one token whose aggregate matches, no token matching within tolerance, tokenIn === tokenOut)
// rejects with a real, attributable reason — never a guess. A close-but-not-exact aggregate (a
// fee-on-transfer token silently taking a cut) is rejected as `swap_event_amount_mismatch`, never
// silently accepted.
//
// SCOPE, DISCLOSED: Aerodrome Classic only — Slipstream's Swap event has no separate In/Out fields
// (decodeLogs.ts's DecodedPoolSwap.amount0/amount1 there is already the exact signed net leg from a
// single, unambiguous event), so index.ts's original resolvePoolLeg (exactly one in + one out
// transfer) is untouched and still used for Slipstream.

import type { DecodedLogs, DecodedPoolSwap, DecodedTransfer } from './decodeLogs'
import type { MultiTransferDiagnostics } from './types'

export type ClassicPoolLeg = {
  swap: DecodedPoolSwap
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
}

export type ClassicResolution =
  | { ok: true; leg: ClassicPoolLeg; diagnostics: MultiTransferDiagnostics }
  | { ok: false; reason: 'contradictory_legs' | 'swap_event_amount_mismatch'; diagnostics: MultiTransferDiagnostics }

// Deterministic, fixed tolerance — 1 raw (smallest-unit) token amount, never a percentage, never
// scaled by decimals (this module never sees decimals — it only compares raw integer amounts).
const RAW_UNIT_TOLERANCE = BigInt('1')

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

function sumByToken(transfers: DecodedTransfer[]): Map<string, bigint> {
  const sums = new Map<string, bigint>()
  for (const t of transfers) sums.set(t.token, (sums.get(t.token) ?? BigInt('0')) + t.value)
  return sums
}

export function resolveClassicMultiTransferLeg(swap: DecodedPoolSwap, decoded: DecodedLogs): ClassicResolution {
  const gross = swap.classicGross
  const pool = swap.poolAddress

  const poolTransfers = decoded.transfers.filter((t) => t.to === pool || t.from === pool)
  const routerIntermediaryTransfersIgnored = decoded.transfers.length - poolTransfers.length

  const diagnosticsBase: MultiTransferDiagnostics = {
    examined: true,
    resolved: false,
    swapEventAmountMatched: null,
    routerIntermediaryTransfersIgnored,
    refundNetted: false,
  }

  // Defensive — every real aerodrome_classic DecodedPoolSwap always carries classicGross (set by
  // decodeLogs.ts's own Classic branch); absent only if a caller constructs one directly.
  if (!gross) return { ok: false, reason: 'contradictory_legs', diagnostics: diagnosticsBase }

  const inNonzeroCount = (gross.amount0In > BigInt('0') ? 1 : 0) + (gross.amount1In > BigInt('0') ? 1 : 0)
  const outNonzeroCount = (gross.amount0Out > BigInt('0') ? 1 : 0) + (gross.amount1Out > BigInt('0') ? 1 : 0)

  // AMBIGUOUS/CONTRADICTORY SWAP EVENT, DISCLOSED: a well-formed simple Classic swap always has
  // exactly one nonzero In side and one nonzero Out side. Zero or both nonzero is itself a
  // contradiction in the Swap event's own values — never guessed at.
  if (inNonzeroCount !== 1 || outNonzeroCount !== 1) {
    return { ok: false, reason: 'contradictory_legs', diagnostics: diagnosticsBase }
  }

  const swapAmountIn = gross.amount0In > BigInt('0') ? gross.amount0In : gross.amount1In
  const swapAmountOut = gross.amount0Out > BigInt('0') ? gross.amount0Out : gross.amount1Out

  const incoming = poolTransfers.filter((t) => t.to === pool)
  const outgoing = poolTransfers.filter((t) => t.from === pool)
  const incomingByToken = sumByToken(incoming)
  const outgoingByToken = sumByToken(outgoing)

  const inMatches = [...incomingByToken.entries()].filter(([, sum]) => absDiff(sum, swapAmountIn) <= RAW_UNIT_TOLERANCE)
  const outMatches = [...outgoingByToken.entries()].filter(([, sum]) => absDiff(sum, swapAmountOut) <= RAW_UNIT_TOLERANCE)

  // AMBIGUOUS TOKEN MAPPING, DISCLOSED: more than one token's aggregate happens to land within
  // tolerance, or no token exists on that side at all — never picked arbitrarily.
  if (incomingByToken.size === 0 || outgoingByToken.size === 0 || inMatches.length > 1 || outMatches.length > 1) {
    return { ok: false, reason: 'contradictory_legs', diagnostics: { ...diagnosticsBase, swapEventAmountMatched: false } }
  }

  // A token exists on this side but its aggregate doesn't land within tolerance of the Swap event's
  // own amount — a real mismatch (fee-on-transfer token taking a cut, or a genuinely inconsistent
  // receipt), never silently accepted.
  if (inMatches.length !== 1 || outMatches.length !== 1) {
    return { ok: false, reason: 'swap_event_amount_mismatch', diagnostics: { ...diagnosticsBase, swapEventAmountMatched: false } }
  }

  const [tokenIn] = inMatches[0]
  const [tokenOut] = outMatches[0]
  if (tokenIn === tokenOut) {
    return { ok: false, reason: 'contradictory_legs', diagnostics: { ...diagnosticsBase, swapEventAmountMatched: false } }
  }

  return {
    ok: true,
    leg: { swap, tokenIn, tokenOut, amountIn: swapAmountIn, amountOut: swapAmountOut },
    diagnostics: { ...diagnosticsBase, resolved: true, swapEventAmountMatched: true },
  }
}

export function mergeMultiTransferDiagnostics(list: MultiTransferDiagnostics[]): MultiTransferDiagnostics | undefined {
  if (list.length === 0) return undefined
  return list.reduce((acc, d) => ({
    examined: acc.examined || d.examined,
    resolved: acc.resolved || d.resolved,
    swapEventAmountMatched: d.swapEventAmountMatched === null ? acc.swapEventAmountMatched : d.swapEventAmountMatched,
    routerIntermediaryTransfersIgnored: acc.routerIntermediaryTransfersIgnored + d.routerIntermediaryTransfersIgnored,
    refundNetted: acc.refundNetted || d.refundNetted,
  }))
}
