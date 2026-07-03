// MODULE — swapNormalizer: lpAddRemoveDetector()
//
// Detects LP_ADD / LP_REMOVE for a single transaction. Two detection strategies, tried in order:
//
//   1. EXPLICIT LP-TOKEN MINT/BURN (strong signal): a transfer of a known LP token (identified via
//      poolMetadata.lpTokenAddress, or a transfer explicitly flagged isLpToken) minted TO the wallet
//      (from === zero address) is LP_ADD; burned FROM the wallet (to === zero address) is
//      LP_REMOVE. Zero-address mint/burn is the real, standard ERC20 convention — not fabricated.
//
//   2. DUAL-TOKEN TRANSFER FALLBACK: when no explicit LP-token transfer is present but poolMetadata
//      confirms this transaction touched a known pool, and exactly two DISTINCT non-LP tokens moved
//      in the SAME direction relative to the wallet (both outbound, or both inbound) — the classic
//      "supplied two tokens to a pool" / "received two tokens back from a pool" shape.
//
// The required output shape has only one tokenIn/tokenOut slot, so for a dual-token event the first
// token by logIndex is used as the reported tokenIn/tokenOut; the other leg is surfaced separately
// via the return type's `secondLeg` field for a caller that wants it, never silently dropped.

import type { PoolMetadata, RawTransfer, TokenRef } from './types'
import { isZeroAddress } from './tokenUtils'
import { tokenRefFromTransfer, toDecimalAmount, byLogIndex } from './tokenUtils'

export type LpDetection = {
  type: 'LP_ADD' | 'LP_REMOVE'
  tokenIn: TokenRef
  tokenOut: TokenRef
  amountIn: number
  amountOut: number
  secondLeg: { token: TokenRef; amount: number } | null
}

function knownLpTokenAddresses(poolMetadata: PoolMetadata[]): Set<string> {
  const set = new Set<string>()
  for (const pool of poolMetadata) {
    if (pool.lpTokenAddress) set.add(pool.lpTokenAddress.toLowerCase())
  }
  return set
}

function isLpTokenTransfer(transfer: RawTransfer, lpAddresses: Set<string>): boolean {
  if (transfer.isLpToken) return true
  return lpAddresses.has(transfer.contract.toLowerCase())
}

export function detectLpAddRemove(
  transfers: RawTransfer[],
  poolMetadata: PoolMetadata[],
  walletAddress: string,
): LpDetection | null {
  const wallet = walletAddress.toLowerCase()
  const lpAddresses = knownLpTokenAddresses(poolMetadata)
  const sorted = [...transfers].sort(byLogIndex)

  // Strategy 1: explicit LP-token mint/burn.
  for (const transfer of sorted) {
    if (!isLpTokenTransfer(transfer, lpAddresses)) continue
    const from = transfer.from.toLowerCase()
    const to = transfer.to.toLowerCase()

    if (to === wallet && isZeroAddress(from)) {
      const lpToken = tokenRefFromTransfer(transfer)
      const amount = toDecimalAmount(transfer.amountRaw, transfer.decimals)
      return {
        type: 'LP_ADD',
        tokenIn: pickUnderlyingToken(sorted, transfer, wallet, 'out') ?? lpToken,
        tokenOut: lpToken,
        amountIn: pickUnderlyingAmount(sorted, transfer, wallet, 'out'),
        amountOut: amount,
        secondLeg: null,
      }
    }
    if (from === wallet && isZeroAddress(to)) {
      const lpToken = tokenRefFromTransfer(transfer)
      const amount = toDecimalAmount(transfer.amountRaw, transfer.decimals)
      return {
        type: 'LP_REMOVE',
        tokenIn: lpToken,
        tokenOut: pickUnderlyingToken(sorted, transfer, wallet, 'in') ?? lpToken,
        amountIn: amount,
        amountOut: pickUnderlyingAmount(sorted, transfer, wallet, 'in'),
        secondLeg: null,
      }
    }
  }

  // Strategy 2: dual-token transfer fallback — only when pool metadata confirms this tx is
  // pool-related (never inferred from transfer shape alone, to avoid misclassifying an ordinary
  // 2-token airdrop/batch transfer as an LP operation).
  if (poolMetadata.length === 0) return null

  const outbound = sorted.filter((t) => t.from.toLowerCase() === wallet && !isLpTokenTransfer(t, lpAddresses))
  const inbound = sorted.filter((t) => t.to.toLowerCase() === wallet && !isLpTokenTransfer(t, lpAddresses))

  const distinctContracts = (list: RawTransfer[]) => new Set(list.map((t) => t.contract.toLowerCase())).size

  if (outbound.length >= 2 && distinctContracts(outbound) >= 2) {
    const [a, b] = outbound
    return {
      type: 'LP_ADD',
      tokenIn: tokenRefFromTransfer(a),
      tokenOut: { address: '', symbol: 'LP_TOKEN', decimals: 18 },
      amountIn: toDecimalAmount(a.amountRaw, a.decimals),
      amountOut: 0,
      secondLeg: { token: tokenRefFromTransfer(b), amount: toDecimalAmount(b.amountRaw, b.decimals) },
    }
  }

  if (inbound.length >= 2 && distinctContracts(inbound) >= 2) {
    const [a, b] = inbound
    return {
      type: 'LP_REMOVE',
      tokenIn: { address: '', symbol: 'LP_TOKEN', decimals: 18 },
      tokenOut: tokenRefFromTransfer(a),
      amountIn: 0,
      amountOut: toDecimalAmount(a.amountRaw, a.decimals),
      secondLeg: { token: tokenRefFromTransfer(b), amount: toDecimalAmount(b.amountRaw, b.decimals) },
    }
  }

  return null
}

// Finds the underlying (non-LP) token transfer the wallet supplied ('out') or received ('in')
// alongside an explicit LP mint/burn, so LP_ADD/LP_REMOVE report a real underlying token rather
// than duplicating the LP token itself into the tokenIn/tokenOut slot. Returns null if no such
// transfer exists in this tx (still a valid, honest outcome — see pickUnderlyingAmount).
function pickUnderlyingToken(
  transfers: RawTransfer[],
  lpTransfer: RawTransfer,
  wallet: string,
  direction: 'in' | 'out',
): TokenRef | null {
  const candidate = transfers.find((t) => {
    if (t === lpTransfer) return false
    if (t.contract.toLowerCase() === lpTransfer.contract.toLowerCase()) return false
    return direction === 'out' ? t.from.toLowerCase() === wallet : t.to.toLowerCase() === wallet
  })
  return candidate ? tokenRefFromTransfer(candidate) : null
}

function pickUnderlyingAmount(
  transfers: RawTransfer[],
  lpTransfer: RawTransfer,
  wallet: string,
  direction: 'in' | 'out',
): number {
  const candidate = transfers.find((t) => {
    if (t === lpTransfer) return false
    if (t.contract.toLowerCase() === lpTransfer.contract.toLowerCase()) return false
    return direction === 'out' ? t.from.toLowerCase() === wallet : t.to.toLowerCase() === wallet
  })
  return candidate ? toDecimalAmount(candidate.amountRaw, candidate.decimals) : 0
}
