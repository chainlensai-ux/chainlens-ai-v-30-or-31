// Liquidity leg guard: keeps liquidity deposits and withdrawals out of priced buys and sells.
//
// Confirmed production shape: a liquidity add sends a token AND a quote asset (USDC/WETH/ETH) into a
// pool router and returns only a dust refund of the token. FIFO reads the token outflow as a sell, and
// whatever USD value the side picks up is not a sale price — publishing it as realized PnL produced a
// -$1.35M "verified" loss on a ~$35k wallet. A real swap never has these shapes:
//   add    — the wallet sends out a non-quote token and a quote asset, and receives no quote asset;
//   remove — the wallet receives a non-quote token and a quote asset, and sends out no quote asset.
// In an add, every non-quote leg of the transaction reads as unpriced; in a remove, every inbound
// non-quote leg does. Nothing is repriced or invented — those legs simply never become priced trades.
//
// Single-token zaps (an LP zapper swaps part of one token and deposits both sides into a position)
// show only the token leaving to the zap contract and a dust remainder of the same token coming back
// from it. A swap does not refund its input like that: an exact-input swap refunds nothing, and a swap
// with a refund also delivers its output. The refund is required, the counterparty must not be a known
// DEX router (a token->ETH sell through one can look the same on Base, where its ETH payout is an
// internal transfer), and the refund must be under 1% of what was sent. A transaction that only brings
// tokens in from a contract this wallet zaps into is the matching withdrawal.
//
// Pools of two non-quote tokens (e.g. cbBTC/AERO on Aerodrome) have no quote leg at all, so the shapes
// are also read from net flow per token: a swap nets one token out and one in, while a deposit nets two
// or more tokens out and a withdrawal nets two or more in. Refunds net away against their own token.

import type { PriceUsdLookup } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { isCanonicalWethAddress, isNativePseudoAddress, isVerifiedStablecoinAddress } from '../modules/quoteLegPricing'
import { isKnownDexRouter } from './knownDexRouters'

const isQuoteAsset = (event: NormalizedEvent) =>
  isVerifiedStablecoinAddress(event.chain, event.contract)
  || isCanonicalWethAddress(event.chain, event.contract)
  || isNativePseudoAddress(event.contract)

const txKey = (event: Pick<NormalizedEvent, 'chain' | 'txHash'>) => `${event.chain}:${event.txHash.toLowerCase()}`
const eventKey = (event: NormalizedEvent) =>
  `${txKey(event)}:${event.contract.toLowerCase()}:${event.direction}:${event.amount}`

export type LiquidityLegGuardResult = {
  lookup: PriceUsdLookup
  liquidityAddTxs: number
  liquidityRemoveTxs: number
  rejectedEvents: number
  // `${chain}:${txHash}` of every liquidity add/remove. FIFO skips these transactions entirely: a
  // deposit is not a sale and a withdrawal is not a buy, so neither may open or close a lot.
  liquidityTxKeys: ReadonlySet<string>
  /** Single-token zap deposits / withdrawals (included in liquidityAddTxs / liquidityRemoveTxs). */
  zapDepositTxs: number
  zapWithdrawTxs: number
  /** Distinct wallet transactions seen, and the share that were liquidity adds/removes. */
  totalTxs: number
  liquidityTxShare: number
  /** Most of this wallet's activity is providing liquidity, not trading. */
  lpStrategyWallet: boolean
  /** Tokens moved by liquidity transactions, most frequent first (at most 10). */
  liquidityTokens: Array<{ token: string; txs: number }>
  /** Contracts the wallet sends liquidity to (zappers, position managers), most used first (at most 3). */
  liquidityCounterparties: string[]
}

// A wallet whose activity is at least this share liquidity adds/removes (and at least this many of
// them) is an LP strategy: its transfer-based trading PnL describes only a small part of it.
export const LP_STRATEGY_MIN_SHARE = 0.25
export const LP_STRATEGY_MIN_TXS = 20
const ZAP_REFUND_MAX_SHARE = 0.01

function zapDepositCounterparty(legs: readonly NormalizedEvent[]): string | null {
  const out = legs.filter((e) => e.direction === 'outbound')
  const inbound = legs.filter((e) => e.direction === 'inbound')
  if (out.length === 0 || inbound.length === 0 || out.length + inbound.length !== legs.length) return null
  const token = out[0].contract.toLowerCase()
  const counterparty = out[0].toAddress?.toLowerCase() ?? null
  if (!counterparty || isKnownDexRouter(counterparty) || isNativePseudoAddress(token)) return null
  if (!out.every((e) => e.contract.toLowerCase() === token && e.toAddress?.toLowerCase() === counterparty)) return null
  if (!inbound.every((e) => e.contract.toLowerCase() === token && e.fromAddress?.toLowerCase() === counterparty)) return null
  const sent = out.reduce((sum, e) => sum + e.amount, 0)
  const refunded = inbound.reduce((sum, e) => sum + e.amount, 0)
  return sent > 0 && refunded <= sent * ZAP_REFUND_MAX_SHARE ? counterparty : null
}

export function guardLiquidityLegs(events: readonly NormalizedEvent[], lookup: PriceUsdLookup): LiquidityLegGuardResult {
  const byTx = new Map<string, NormalizedEvent[]>()
  for (const event of events) {
    const key = txKey(event)
    const list = byTx.get(key)
    if (list) list.push(event)
    else byTx.set(key, [event])
  }
  const rejected = new Set<string>()
  let liquidityAddTxs = 0
  let liquidityRemoveTxs = 0
  const liquidityTxKeys = new Set<string>()
  const tokenTxCounts = new Map<string, number>()
  const counterpartyCounts = new Map<string, number>()
  const markLiquidityTx = (key: string, legs: readonly NormalizedEvent[]) => {
    liquidityTxKeys.add(key)
    for (const to of new Set(legs.filter((e) => e.direction === 'outbound').map((e) => e.toAddress?.toLowerCase()))) {
      if (to && !isKnownDexRouter(to)) counterpartyCounts.set(to, (counterpartyCounts.get(to) ?? 0) + 1)
    }
    for (const token of new Set(legs.filter((e) => !isQuoteAsset(e)).map((e) => e.contract.toLowerCase()))) {
      tokenTxCounts.set(token, (tokenTxCounts.get(token) ?? 0) + 1)
    }
  }
  let zapDepositTxs = 0
  let zapWithdrawTxs = 0
  const zapCounterparties = new Set<string>()
  const inboundOnly: Array<[string, NormalizedEvent[]]> = []
  for (const [key, legs] of byTx) {
    const quoteOut = legs.some((e) => e.direction === 'outbound' && isQuoteAsset(e))
    const quoteIn = legs.some((e) => e.direction === 'inbound' && isQuoteAsset(e))
    const tokenOut = legs.some((e) => e.direction === 'outbound' && !isQuoteAsset(e))
    const tokenIn = legs.some((e) => e.direction === 'inbound' && !isQuoteAsset(e))
    const net = new Map<string, number>()
    for (const e of legs) {
      const token = e.contract.toLowerCase()
      net.set(token, (net.get(token) ?? 0) + (e.direction === 'inbound' ? e.amount : -e.amount))
    }
    const netOutTokens = [...net.values()].filter((v) => v < 0).length
    const netInTokens = [...net.values()].filter((v) => v > 0).length
    const zapCounterparty = zapDepositCounterparty(legs)
    if ((tokenOut && quoteOut && !quoteIn) || netOutTokens >= 2) {
      liquidityAddTxs += 1
      markLiquidityTx(key, legs)
      for (const e of legs) if (!isQuoteAsset(e)) rejected.add(eventKey(e))
    } else if ((tokenIn && quoteIn && !quoteOut) || (netInTokens >= 2 && netOutTokens <= 1)) {
      liquidityRemoveTxs += 1
      markLiquidityTx(key, legs)
      for (const e of legs) if (e.direction === 'inbound' && !isQuoteAsset(e)) rejected.add(eventKey(e))
    } else if (zapCounterparty) {
      liquidityAddTxs += 1
      zapDepositTxs += 1
      zapCounterparties.add(zapCounterparty)
      markLiquidityTx(key, legs)
      for (const e of legs) rejected.add(eventKey(e))
    } else if (legs.every((e) => e.direction === 'inbound')) {
      inboundOnly.push([key, legs])
    }
  }
  for (const [key, legs] of inboundOnly) {
    if (!legs.every((e) => zapCounterparties.has(e.fromAddress?.toLowerCase() ?? ''))) continue
    liquidityRemoveTxs += 1
    zapWithdrawTxs += 1
    markLiquidityTx(key, legs)
    for (const e of legs) rejected.add(eventKey(e))
  }
  const totalTxs = byTx.size
  const liquidityTxShare = totalTxs > 0 ? liquidityTxKeys.size / totalTxs : 0
  return {
    lookup: rejected.size === 0 ? lookup : (event) => (rejected.has(eventKey(event)) ? null : lookup(event)),
    liquidityAddTxs,
    liquidityRemoveTxs,
    rejectedEvents: rejected.size,
    liquidityTxKeys,
    zapDepositTxs,
    zapWithdrawTxs,
    totalTxs,
    liquidityTxShare,
    lpStrategyWallet: liquidityTxKeys.size >= LP_STRATEGY_MIN_TXS && liquidityTxShare >= LP_STRATEGY_MIN_SHARE,
    liquidityTokens: [...tokenTxCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([token, txs]) => ({ token, txs })),
    liquidityCounterparties: [...counterpartyCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([address]) => address),
  }
}

// What the Wallet Scanner shows about a wallet's liquidity activity (`RunWalletScanResult.liquidityActivity`).
export type LiquidityActivitySummary = {
  lpStrategyWallet: boolean
  liquidityAddTxs: number
  liquidityRemoveTxs: number
  zapDepositTxs: number
  zapWithdrawTxs: number
  totalTxs: number
  liquidityTxShare: number
  liquidityTokens: Array<{ token: string; txs: number }>
}

export function summarizeLiquidityActivity(guard: LiquidityLegGuardResult): LiquidityActivitySummary {
  const { lpStrategyWallet, liquidityAddTxs, liquidityRemoveTxs, zapDepositTxs, zapWithdrawTxs, totalTxs, liquidityTxShare, liquidityTokens } = guard
  return { lpStrategyWallet, liquidityAddTxs, liquidityRemoveTxs, zapDepositTxs, zapWithdrawTxs, totalTxs, liquidityTxShare, liquidityTokens }
}

/** The Wallet Condition line for an LP-strategy wallet, or null for any other wallet. */
export function lpStrategyConditionText(summary: LiquidityActivitySummary): string | null {
  if (!summary.lpStrategyWallet) return null
  const pct = Math.round(summary.liquidityTxShare * 100)
  return `Liquidity provider: ${pct}% of this wallet's transactions (${summary.liquidityAddTxs} deposits, ${summary.liquidityRemoveTxs} withdrawals) add or remove liquidity. `
    + 'Those are left out of trading PnL, which covers swaps only; LP fees, rewards and the value held in liquidity positions are not part of it.'
}
