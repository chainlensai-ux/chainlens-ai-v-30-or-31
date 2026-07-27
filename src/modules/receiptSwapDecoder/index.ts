// MODULE — receiptSwapDecoder: receipt-first swap decoding, Phase 1.
//
// SCOPE, DISCLOSED: Base chain only. Aerodrome Classic (volatile) pool swaps and Aerodrome
// Slipstream pool swaps only — no Uniswap, no aggregators, no other protocols yet (a future phase
// can add more protocols by adding more pool-event signatures/factories; nothing here assumes only
// two protocols will ever exist).
//
// GOAL: decode the exact economic swap directly from a transaction's own logs (real pool Swap
// events, cross-checked against real ERC20 Transfer legs touching that exact pool address, in the
// SAME transaction) BEFORE falling back to the existing generic transfer/router inference
// (swapNormalizer's reconstructFromTransfers / routerInference.ts). Receipt-decoded evidence is
// strictly higher-confidence than inference: an inference pass only ever sees flat transfers and
// has to guess which ones are the "real" swap legs by position/heuristic; a decoded pool Swap event
// is direct proof the AMM's own invariant was invoked for these exact tokens/amounts.
//
// PROVIDER-CALL DISCIPLINE, DISCLOSED: this module's own decode logic (decodeLogs.ts) takes
// whatever `logs` the caller already has (reused from an existing receipt fetch — never re-fetched
// here) and never calls out for token identity: the two token addresses a pool swap involves are
// read directly off the accompanying ERC20 Transfer logs INTO and OUT OF that same pool address in
// the same tx (no extra eth_call needed to ask a pool for its own token0/token1). The one place a
// new provider call is unavoidable is pool *validation* (poolValidator.ts's isValidPool, a real
// factory getPool() read) — validation is what turns "a contract that emitted a Swap-shaped log"
// into "a real, canonical Aerodrome pool", so it cannot be skipped without weakening the exact
// guarantee this module exists to provide. It is a single injectable dependency (fake in every
// test below; live-RPC only through poolValidator.ts's createLiveBaseDexPoolValidator) so it is
// never a mandatory network call from a unit test, and shadowMode.ts's `newProviderCalls` counter
// tracks exactly how many of these validation calls a batch triggers.
//
// FAIL-CLOSED, DISCLOSED: any incomplete or contradictory decode (an unmatched leg, more than one
// candidate incoming/outgoing transfer for a pool, an unvalidated pool, a plain transfer with no
// pool event at all) returns `{ ok: false, rejection }` — callers fall back to the existing
// inference path. This module never emits a low-confidence guess as if it were receipt-decoded.

import type { DecodedLogs, DecodedPoolSwap } from './decodeLogs'
import { decodeLogs } from './decodeLogs'
import type { PoolValidator } from './poolValidator'
import { WETH_BASE_ADDRESS } from './signatures'
import type {
  DecodedReceiptSwap, ReceiptDecodeResult, ReceiptTxBundle, TokenMeta, WalletDirection, MultiTransferDiagnostics,
} from './types'
import { resolveClassicMultiTransferLeg, mergeMultiTransferDiagnostics, type ClassicPoolLeg } from './multiTransferLeg'
import { resolveUniswapV3Leg, type UniswapV3PoolLeg } from './uniswapV3Leg'
import type { UniswapV3PoolValidator } from './uniswapV3PoolValidator'
import type { UniswapV3Diagnostics } from './types'

export type { DecodedReceiptSwap, ReceiptDecodeResult, ReceiptTxBundle } from './types'
export { decodeLogs } from './decodeLogs'

function tokenMetaFor(meta: Record<string, TokenMeta> | undefined, address: string): TokenMeta {
  return meta?.[address.toLowerCase()] ?? { symbol: '?', decimals: 18 }
}

function toNormalized(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals
}

type PoolLeg = ClassicPoolLeg

// Resolves one Slipstream pool's swap event to concrete token addresses/amounts by matching it
// against the EXACTLY one ERC20 Transfer log flowing into the pool and the exactly one flowing out
// of it, in this same transaction. More or fewer than one of either side is contradictory
// (ambiguous which transfer is the real swap leg) and is rejected rather than guessed.
//
// CLASSIC USES A DIFFERENT RESOLVER, DISCLOSED: Aerodrome Classic pool legs are resolved by
// multiTransferLeg.ts's resolveClassicMultiTransferLeg instead — see that module's own header for
// why (real router-mediated Classic swaps can have more than one transfer per side; Slipstream's
// Swap event carries no separate In/Out fields to authoritatively re-derive from, so it keeps this
// original, stricter exactly-one-each match).
function resolvePoolLeg(swap: DecodedPoolSwap, decoded: DecodedLogs): PoolLeg | null {
  const incoming = decoded.transfers.filter((t) => t.to === swap.poolAddress && t.value > BigInt("0"))
  const outgoing = decoded.transfers.filter((t) => t.from === swap.poolAddress && t.value > BigInt("0"))
  if (incoming.length !== 1 || outgoing.length !== 1) return null
  const [tokenIn] = incoming
  const [tokenOut] = outgoing
  if (tokenIn.token === tokenOut.token) return null
  return { swap, tokenIn: tokenIn.token, tokenOut: tokenOut.token, amountIn: tokenIn.value, amountOut: tokenOut.value }
}

// Chains individually-resolved pool legs into one end-to-end path (handles router intermediaries
// and multi-hop transactions): the leg whose tokenIn is never any other leg's tokenOut is the true
// start; the leg whose tokenOut is never any other leg's tokenIn is the true end. Requires the legs
// to form exactly one connected chain from start to end — any branching or disconnected leg is
// contradictory and rejected (fails closed to inference).
function chainLegs(legs: PoolLeg[]): PoolLeg[] | null {
  if (legs.length === 0) return null
  if (legs.length === 1) return legs

  const byTokenIn = new Map<string, PoolLeg[]>()
  for (const leg of legs) {
    const list = byTokenIn.get(leg.tokenIn) ?? []
    list.push(leg)
    byTokenIn.set(leg.tokenIn, list)
  }
  const producedTokens = new Set(legs.map((l) => l.tokenOut))
  const consumedTokens = new Set(legs.map((l) => l.tokenIn))

  const starts = legs.filter((l) => !producedTokens.has(l.tokenIn))
  const ends = legs.filter((l) => !consumedTokens.has(l.tokenOut))
  if (starts.length !== 1 || ends.length !== 1) return null

  const ordered: PoolLeg[] = [starts[0]]
  let current = starts[0]
  const seen = new Set<PoolLeg>([current])
  while (current !== ends[0]) {
    const next = (byTokenIn.get(current.tokenOut) ?? []).find((l) => !seen.has(l))
    if (!next) return null
    ordered.push(next)
    seen.add(next)
    current = next
  }
  return ordered.length === legs.length ? ordered : null
}

function classifyDirection(tokenIn: string, tokenOut: string): WalletDirection {
  const inIsBase = tokenIn === WETH_BASE_ADDRESS.toLowerCase()
  const outIsBase = tokenOut === WETH_BASE_ADDRESS.toLowerCase()
  if (inIsBase && !outIsBase) return 'wallet_bought_tokenOut'
  if (!inIsBase && outIsBase) return 'wallet_sold_tokenIn'
  return 'wallet_swapped'
}

// Builds the final DecodedReceiptSwap for a successfully-resolved-and-validated Uniswap V3 leg —
// same wrap/refund diagnostics computation as the Aerodrome path below, just for a single leg
// (V3 fallback is only ever attempted for one concentrated-liquidity Swap event at a time).
function buildUniswapV3Swap(
  tx: ReceiptTxBundle,
  decoded: DecodedLogs,
  poolAddress: string,
  leg: UniswapV3PoolLeg,
  fee: number | null,
  diagnostics: UniswapV3Diagnostics,
): ReceiptDecodeResult {
  void diagnostics
  const walletAddress = tx.walletAddress.toLowerCase()
  const nativeWrapDetected = decoded.nativeWraps.some(
    (w) => w.account === walletAddress || w.account === (tx.router ?? '').toLowerCase(),
  )
  const refundDetected = decoded.transfers.some(
    (t) => t.token === leg.tokenIn && t.to === walletAddress && t.value > BigInt('0'),
  )

  const tokenInMeta = tokenMetaFor(tx.tokenMeta, leg.tokenIn)
  const tokenOutMeta = tokenMetaFor(tx.tokenMeta, leg.tokenOut)

  const swap: DecodedReceiptSwap = {
    chain: tx.chain,
    txHash: tx.txHash,
    protocol: 'uniswap_v3',
    poolAddress,
    tokenIn: { address: leg.tokenIn, symbol: tokenInMeta.symbol, decimals: tokenInMeta.decimals },
    tokenOut: { address: leg.tokenOut, symbol: tokenOutMeta.symbol, decimals: tokenOutMeta.decimals },
    amountInRaw: leg.amountIn.toString(),
    amountOutRaw: leg.amountOut.toString(),
    decimals: { tokenIn: tokenInMeta.decimals, tokenOut: tokenOutMeta.decimals },
    normalizedAmountIn: toNormalized(leg.amountIn, tokenInMeta.decimals),
    normalizedAmountOut: toNormalized(leg.amountOut, tokenOutMeta.decimals),
    walletDirection: classifyDirection(leg.tokenIn, leg.tokenOut),
    evidenceSource: 'receipt_pool_swap_event',
    confidence: 'exact',
    meta: {
      hops: 1,
      poolsVisited: [poolAddress],
      nativeWrapDetected,
      refundDetected,
      feeLegsExcluded: Math.max(0, decoded.transfers.length - 2),
      ...(fee !== null ? { uniswapV3Fee: fee } : {}),
    },
  }

  return { ok: true, swap }
}

// UNISWAP V3 FALLBACK, DISCLOSED: `uniswapV3Validator` is optional and backward-compatible — every
// existing caller/test that omits it gets IDENTICAL behavior to before this parameter existed
// (the fallback below is simply never attempted). When supplied, it is only ever consulted for a
// SINGLE concentrated-liquidity-shaped Swap event (decoded.swaps.length === 1, protocol tag
// 'aerodrome_slipstream' — the shared topic0 shape) whose Aerodrome Slipstream factory validation
// has ALREADY genuinely failed — never the first attempt, never for a multi-hop/mixed-protocol tx
// ("multiple incompatible pools" fails closed to the existing rejection by design, not attempted
// here).
export async function decodeReceiptSwap(
  tx: ReceiptTxBundle,
  validator: PoolValidator,
  uniswapV3Validator?: UniswapV3PoolValidator,
): Promise<ReceiptDecodeResult> {
  if (!tx.logs || tx.logs.length === 0) {
    return { ok: false, rejection: { txHash: tx.txHash, reason: 'no_logs' } }
  }

  const decoded = decodeLogs(tx.logs)

  if (decoded.malformed > 0 && decoded.swaps.length === 0) {
    return { ok: false, rejection: { txHash: tx.txHash, reason: 'malformed_log_data' } }
  }

  // LP ADD/REMOVE, NEVER A SWAP, DISCLOSED: any Mint/Burn on a pool that ALSO shows up in this same
  // tx is decisive — an LP operation is never reclassified as a swap regardless of what other
  // events are present in the same transaction.
  if (decoded.lpEvents.length > 0) {
    return { ok: false, rejection: { txHash: tx.txHash, reason: 'lp_add_or_remove_detected' } }
  }

  if (decoded.swaps.length === 0) {
    return decoded.transfers.length > 0
      ? { ok: false, rejection: { txHash: tx.txHash, reason: 'plain_transfer_no_swap_event' } }
      : { ok: false, rejection: { txHash: tx.txHash, reason: 'no_recognized_pool_swap_event' } }
  }

  const legs: PoolLeg[] = []
  const multiTransferDiagnosticsList: MultiTransferDiagnostics[] = []
  for (const swap of decoded.swaps) {
    if (swap.protocol === 'aerodrome_classic') {
      const resolution = resolveClassicMultiTransferLeg(swap, decoded)
      multiTransferDiagnosticsList.push(resolution.diagnostics)
      if (!resolution.ok) {
        return {
          ok: false,
          rejection: { txHash: tx.txHash, reason: resolution.reason, multiTransfer: mergeMultiTransferDiagnostics(multiTransferDiagnosticsList) },
        }
      }
      legs.push(resolution.leg)
      continue
    }
    const leg = resolvePoolLeg(swap, decoded)
    if (!leg) {
      return {
        ok: false,
        rejection: {
          txHash: tx.txHash, reason: 'contradictory_legs',
          multiTransfer: mergeMultiTransferDiagnostics(multiTransferDiagnosticsList),
        },
      }
    }
    legs.push(leg)
  }

  const chained = chainLegs(legs)
  if (!chained) {
    return {
      ok: false,
      rejection: { txHash: tx.txHash, reason: 'contradictory_legs', multiTransfer: mergeMultiTransferDiagnostics(multiTransferDiagnosticsList) },
    }
  }

  // FACTORY VALIDATION, DISCLOSED: every pool in the chain must be confirmed by its protocol's real
  // factory for the exact token pair the leg claims — an unvalidated pool (a look-alike contract, a
  // custom/forked pool never deployed by the canonical factory) fails closed to inference rather
  // than being trusted on log shape alone.
  for (const leg of chained) {
    const isValid = await validator.isValidPool(leg.swap.protocol, leg.swap.poolAddress, leg.tokenIn, leg.tokenOut)
    if (!isValid) {
      // UNISWAP V3 FALLBACK, DISCLOSED: only reachable for a single concentrated-liquidity-shaped
      // Swap event whose Aerodrome Slipstream validation just genuinely failed — see this
      // function's own header. A multi-hop/mixed chain never reaches here (chained.length > 1
      // simply falls through to the original rejection below), so "multiple incompatible pools"
      // fails closed by construction, not by an extra check.
      if (uniswapV3Validator && chained.length === 1 && leg.swap.protocol === 'aerodrome_slipstream') {
        const v3 = resolveUniswapV3Leg(leg.swap, decoded)
        if (!v3.ok) {
          return { ok: false, rejection: { txHash: tx.txHash, reason: v3.reason, uniswapV3: v3.diagnostics } }
        }
        const v3Valid = await uniswapV3Validator.validatePool(leg.swap.poolAddress, v3.leg.tokenIn, v3.leg.tokenOut)
        if (!v3Valid.valid) {
          return { ok: false, rejection: { txHash: tx.txHash, reason: 'uniswap_v3_pool_not_validated', uniswapV3: v3.diagnostics } }
        }
        return buildUniswapV3Swap(tx, decoded, leg.swap.poolAddress, v3.leg, v3Valid.fee, v3.diagnostics)
      }
      return {
        ok: false,
        rejection: { txHash: tx.txHash, reason: 'pool_not_validated_by_factory', multiTransfer: mergeMultiTransferDiagnostics(multiTransferDiagnosticsList) },
      }
    }
  }

  const first = chained[0]
  const last = chained[chained.length - 1]

  const walletAddress = tx.walletAddress.toLowerCase()
  const nativeWrapDetected = decoded.nativeWraps.some(
    (w) => w.account === walletAddress || w.account === (tx.router ?? '').toLowerCase(),
  )

  // REFUND, DIAGNOSTIC-ONLY, DISCLOSED: any transfer of the SAME tokenIn token back to the wallet
  // after the swap leg (beyond what the pool actually consumed) is a refund of unused input —
  // tracked in `meta.refundDetected` only. The canonical amountInRaw stays the pool's own consumed
  // amount (the exact economic swap), never the wallet's gross pre-refund send.
  const refundDetected = decoded.transfers.some(
    (t) => t.token === first.tokenIn && t.to === walletAddress && t.logIndex > first.swap.logIndex,
  )

  const feeLegsExcluded = decoded.transfers.length - chained.reduce((count, leg) => {
    void leg
    return count + 2 // one incoming + one outgoing transfer already accounted for per leg
  }, 0)

  const multiTransfer = mergeMultiTransferDiagnostics(multiTransferDiagnosticsList)
  if (multiTransfer && refundDetected) multiTransfer.refundNetted = true

  const tokenInMeta = tokenMetaFor(tx.tokenMeta, first.tokenIn)
  const tokenOutMeta = tokenMetaFor(tx.tokenMeta, last.tokenOut)

  const swap: DecodedReceiptSwap = {
    chain: tx.chain,
    txHash: tx.txHash,
    protocol: first.swap.protocol,
    poolAddress: first.swap.poolAddress,
    tokenIn: { address: first.tokenIn, symbol: tokenInMeta.symbol, decimals: tokenInMeta.decimals },
    tokenOut: { address: last.tokenOut, symbol: tokenOutMeta.symbol, decimals: tokenOutMeta.decimals },
    amountInRaw: first.amountIn.toString(),
    amountOutRaw: last.amountOut.toString(),
    decimals: { tokenIn: tokenInMeta.decimals, tokenOut: tokenOutMeta.decimals },
    normalizedAmountIn: toNormalized(first.amountIn, tokenInMeta.decimals),
    normalizedAmountOut: toNormalized(last.amountOut, tokenOutMeta.decimals),
    walletDirection: classifyDirection(first.tokenIn, last.tokenOut),
    evidenceSource: chained.length > 1 ? 'receipt_pool_swap_event_multi_hop' : 'receipt_pool_swap_event',
    confidence: 'exact',
    meta: {
      hops: chained.length,
      poolsVisited: chained.map((l) => l.swap.poolAddress),
      nativeWrapDetected,
      refundDetected,
      feeLegsExcluded: Math.max(0, feeLegsExcluded),
      multiTransfer,
    },
  }

  return { ok: true, swap }
}
