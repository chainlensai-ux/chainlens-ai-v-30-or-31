// MODULE — receiptSwapDecoder: Aerodrome Slipstream multi-transfer pool-leg resolution.
//
// GOAL, DISCLOSED (evidence-first PnL completion task, requirement #7): production proof — a real
// Aerodrome Slipstream multihop transaction was rejected as `contradictory_legs` purely because
// index.ts's original per-pool resolver (the old `resolvePoolLeg`) required EXACTLY one incoming and
// one outgoing ERC20 Transfer touching each pool. A real router-mediated Slipstream multihop can
// legitimately involve more transfers touching a given pool than that (an intermediate hop token
// passing through the same pool address twice within one swap call, a router-side refund leg, a fee
// collection transfer) without the underlying swap being any less real or exact.
//
// FIX, DISCLOSED: this mirrors multiTransferLeg.ts's already-shipped fix for Aerodrome Classic
// (resolveClassicMultiTransferLeg) and reuses the exact SIGN-BASED reconciliation algorithm
// uniswapV3Leg.ts's resolveUniswapV3Leg already implements and has already been proven correct for —
// Slipstream's own Swap event carries the identical signed (amount0, amount1) net-flow pair
// Uniswap V3 does (decodeLogs.ts: "aerodrome_slipstream ... amount0, amount1" — the same
// SLIPSTREAM_SWAP_TOPIC0 signature both forks share), so the same reconciliation is directly valid
// here, not a new or weaker proof. The pool's own signed net values are never re-derived or guessed;
// the ERC20 Transfer logs are used ONLY to identify WHICH token corresponds to which side, by
// aggregating every same-token transfer that actually touches the validated pool (summing
// duplicates, ignoring every transfer that doesn't touch the pool) and matching that aggregate
// against the Swap event's own amount within the same strict, deterministic 1-raw-unit tolerance
// multiTransferLeg.ts already uses.
//
// FAIL-CLOSED, DISCLOSED: any ambiguity (both amount0/amount1 the same sign or either zero, more
// than one token whose aggregate matches a side, no token matching within tolerance, tokenIn ===
// tokenOut) rejects with the SAME real, attributable reason vocabulary multiTransferLeg.ts already
// uses (`contradictory_legs` / `swap_event_amount_mismatch`) — never a new, parallel reason
// taxonomy, and never a guess. A close-but-not-exact aggregate is rejected as
// `swap_event_amount_mismatch`, never silently accepted — no confidence weakening versus the prior
// strict resolver; this only widens WHICH transfer sets are recognized as unambiguous, never how
// tightly amounts must reconcile.
//
// REUSES CLASSIC'S PoolLeg/MultiTransferDiagnostics SHAPE, DISCLOSED: returning the exact same
// `ClassicPoolLeg`-shaped leg and `MultiTransferDiagnostics` multiTransferLeg.ts already produces
// means index.ts's existing `chainLegs`, factory-validation loop, and
// `mergeMultiTransferDiagnostics` all work unchanged for a Slipstream-resolved leg — no downstream
// code needed to change to consume this.

import type { DecodedLogs, DecodedPoolSwap, DecodedTransfer } from './decodeLogs'
import type { MultiTransferDiagnostics } from './types'
import type { ClassicPoolLeg, ClassicResolution } from './multiTransferLeg'

const RAW_UNIT_TOLERANCE = BigInt('1')

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

function sumByToken(transfers: DecodedTransfer[]): Map<string, bigint> {
  const sums = new Map<string, bigint>()
  for (const t of transfers) sums.set(t.token, (sums.get(t.token) ?? BigInt('0')) + t.value)
  return sums
}

// PURE, offline — no provider calls, no I/O. `swap` must be a real Aerodrome Slipstream
// DecodedPoolSwap (protocol === 'aerodrome_slipstream', amount0/amount1 already the exact signed
// net values decodeLogs.ts computed from the log data); `decoded` is the same in-memory
// decodeLogs.ts output already computed for this receipt.
export function resolveSlipstreamMultiTransferLeg(swap: DecodedPoolSwap, decoded: DecodedLogs): ClassicResolution {
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

  const zero = BigInt('0')
  const positiveCount = (swap.amount0 > zero ? 1 : 0) + (swap.amount1 > zero ? 1 : 0)
  const negativeCount = (swap.amount0 < zero ? 1 : 0) + (swap.amount1 < zero ? 1 : 0)

  // AMBIGUOUS/CONTRADICTORY SWAP EVENT, DISCLOSED: a well-formed Slipstream swap always has exactly
  // one positive (pool received) side and one negative (pool paid out) side — anything else is a
  // contradiction in the Swap event's own reported amounts, never guessed at.
  if (positiveCount !== 1 || negativeCount !== 1) {
    return { ok: false, reason: 'contradictory_legs', diagnostics: diagnosticsBase }
  }

  const swapAmountIn = swap.amount0 > zero ? swap.amount0 : swap.amount1
  const swapAmountOut = swap.amount0 < zero ? -swap.amount0 : -swap.amount1

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

  const leg: ClassicPoolLeg = { swap, tokenIn, tokenOut, amountIn: swapAmountIn, amountOut: swapAmountOut }
  return { ok: true, leg, diagnostics: { ...diagnosticsBase, resolved: true, swapEventAmountMatched: true } }
}
