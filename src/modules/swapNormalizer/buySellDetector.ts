// MODULE — swapNormalizer: buySellDetector()
//
// Classifies a resolved (tokenIn, tokenOut) swap as BUY, SELL, or generic SWAP.
//
// DEFINITION USED HERE (documented, since the literal spec text — "BUY = wallet receives tokenOut,
// SELL = wallet sends tokenIn" — is true of every swap by construction and can't alone distinguish
// BUY from SELL from a generic token-to-token SWAP): this module treats a fixed set of "quote"
// assets (stablecoins + native/wrapped-native) as the settlement side of a trade, same convention
// already used by this codebase's src/modules/tradeLedger.ts QUOTE_ASSETS set:
//   - tokenIn is a quote asset, tokenOut is not  -> BUY  (spent a stable/native asset to acquire X)
//   - tokenOut is a quote asset, tokenIn is not  -> SELL (acquired a stable/native asset for X)
//   - both or neither are quote assets           -> SWAP (token-to-token, not a buy or a sell)
// isBuy/isSell mirror the resolved type exactly (isBuy = type === 'BUY', isSell = type === 'SELL')
// so a SWAP row is never double-counted as both a buy and a sell.
//
// MISSING-SIDE HANDLING ("must work even when Covalent misses one side"): when one side resolved to
// the UNKNOWN placeholder (see types.ts), this module still returns a best-effort classification
// from the KNOWN side alone — receiving an unresolved token in exchange for a known quote asset is
// treated as a BUY; parting with an unresolved token for a known quote asset is treated as a SELL.
// This is a documented heuristic on the known side's role, never a guess at the missing token's
// actual identity.

import type { TokenRef } from './types'
import { isWrappedNative } from './tokenUtils'
import type { SwapNormalizerChain } from './types'

// Same convention as src/modules/tradeLedger.ts's QUOTE_ASSETS — kept as an independent literal
// copy here (this module's own "no runtime coupling between modules" convention, matching
// providerFetchWindow/recoveryPolicy/holdings elsewhere in this codebase).
const QUOTE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'WETH', 'ETH', 'USDBC', 'CBETH'])

export function isQuoteAsset(chain: SwapNormalizerChain, token: TokenRef): boolean {
  if (isWrappedNative(chain, token.address)) return true
  return QUOTE_SYMBOLS.has(token.symbol.toUpperCase())
}

export type BuySellResult = { type: 'BUY' | 'SELL' | 'SWAP'; isBuy: boolean; isSell: boolean }

export function detectBuySell(
  chain: SwapNormalizerChain,
  tokenIn: TokenRef,
  tokenOut: TokenRef,
  missingSide: 'none' | 'tokenIn' | 'tokenOut',
): BuySellResult {
  if (missingSide === 'tokenOut') {
    // Wallet's known side (tokenIn) is what they parted with. If it's a quote asset, treat
    // "spent a quote asset for an unresolved token" as a BUY.
    const type = isQuoteAsset(chain, tokenIn) ? 'BUY' : 'SWAP'
    return { type, isBuy: type === 'BUY', isSell: false }
  }
  if (missingSide === 'tokenIn') {
    const type = isQuoteAsset(chain, tokenOut) ? 'SELL' : 'SWAP'
    return { type, isBuy: false, isSell: type === 'SELL' }
  }

  const inIsQuote = isQuoteAsset(chain, tokenIn)
  const outIsQuote = isQuoteAsset(chain, tokenOut)

  if (inIsQuote && !outIsQuote) return { type: 'BUY', isBuy: true, isSell: false }
  if (outIsQuote && !inIsQuote) return { type: 'SELL', isBuy: false, isSell: true }
  return { type: 'SWAP', isBuy: false, isSell: false }
}
