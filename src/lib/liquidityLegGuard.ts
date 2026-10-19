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
// Pools of two non-quote tokens (e.g. cbBTC/AERO on Aerodrome) have no quote leg at all, so the shapes
// are also read from net flow per token: a swap nets one token out and one in, while a deposit nets two
// or more tokens out and a withdrawal nets two or more in. Refunds net away against their own token.

import type { PriceUsdLookup } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { isCanonicalWethAddress, isNativePseudoAddress, isVerifiedStablecoinAddress } from '../modules/quoteLegPricing'

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
    if ((tokenOut && quoteOut && !quoteIn) || netOutTokens >= 2) {
      liquidityAddTxs += 1
      liquidityTxKeys.add(key)
      for (const e of legs) if (!isQuoteAsset(e)) rejected.add(eventKey(e))
    } else if ((tokenIn && quoteIn && !quoteOut) || (netInTokens >= 2 && netOutTokens <= 1)) {
      liquidityRemoveTxs += 1
      liquidityTxKeys.add(key)
      for (const e of legs) if (e.direction === 'inbound' && !isQuoteAsset(e)) rejected.add(eventKey(e))
    }
  }
  return {
    lookup: rejected.size === 0 ? lookup : (event) => (rejected.has(eventKey(event)) ? null : lookup(event)),
    liquidityAddTxs,
    liquidityRemoveTxs,
    rejectedEvents: rejected.size,
    liquidityTxKeys,
  }
}
