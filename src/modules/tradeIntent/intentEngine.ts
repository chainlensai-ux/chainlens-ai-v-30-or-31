// MODULE — tradeIntent: BUY/SELL Intent Engine for Wallet Scanner V2.
//
// STANDALONE, ADDITIVE, NOT WIRED INTO THE PIPELINE — same convention as src/modules/
// swapNormalizer (which this module consumes): a new, unwired module, no existing file modified.
// Pure classification only — no I/O, no randomness, no pricing/FIFO/PnL logic.
//
// TYPE-SHAPE CORRECTION, DISCLOSED: the requested spec described `meta.missingSide` as
// `"none" | "in" | "out"` and `amountIn`/`amountOut` as `number | string`. The REAL, already-shipped
// NormalizedTrade type (src/modules/swapNormalizer/types.ts) uses `missingSide: "none" | "tokenIn" |
// "tokenOut"` and `amountIn`/`amountOut: number`. Built against the real type (imported directly,
// not redefined) rather than the spec's paraphrase — redefining a parallel/slightly-different local
// type would silently drift from the actual upstream module and break at the integration point.
//
// "GAS TOKEN" CORRECTION, DISCLOSED: the spec's example base/stable list includes "major L2 gas
// tokens (e.g. OP, ARB, BASE native if applicable)" — OP and ARB are Optimism's and Arbitrum's
// governance tokens, not gas tokens; gas on Base, Optimism, and Arbitrum is paid in ETH, same as
// Ethereum mainnet. There is no separate "BASE native" gas token. OP and ARB are still included
// below as major, liquid, non-volatile-in-the-trading-sense assets (a defensible design choice on
// their own merits), just not because they're "gas tokens".
//
// ADDRESS-VERIFICATION DISCLOSURE: this sandbox has no live network access to re-verify every
// per-chain token address against a block explorer. WETH addresses reuse the same registry already
// verified elsewhere in this codebase (src/modules/swapNormalizer/tokenUtils.ts). Ethereum mainnet
// USDC/USDT/DAI are long-standing, extremely well-documented canonical addresses. Base's native USDC
// reuses the address already used in src/modules/pricingAtTimeEngine/sources/basedex.ts this
// session. Arbitrum/Optimism native USDC and the OP/ARB token addresses are best-effort — symbol
// matching (case-insensitive) is the PRIMARY, authoritative check for this reason; address matching
// is a secondary, defense-in-depth check only, never required for a correct classification.

import type { NormalizedTrade, TokenRef } from '../swapNormalizer'

export type TradeIntent = 'BUY' | 'SELL' | 'SWAP' | 'LP_ADD' | 'LP_REMOVE'

export type TradeWithIntent = NormalizedTrade & {
  intent: TradeIntent
  intentReason: string
}

// ─── Base/stable registry ───────────────────────────────────────────────────

const BASE_STABLE_SYMBOLS = new Set([
  'ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'USDBC', 'OP', 'ARB',
])

// Lowercased addresses, grouped by role for readability — not by chain, since a single flat set is
// all isBaseOrStable() needs (an address collision across chains here would only ever produce a
// false positive for a token that happens to reuse a canonical stable/wrapped-native address, which
// does not happen in practice).
const BASE_STABLE_ADDRESSES = new Set(
  [
    // WETH (verified elsewhere in this codebase — src/modules/swapNormalizer/tokenUtils.ts)
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH — Ethereum mainnet
    '0x4200000000000000000000000000000000000006', // WETH — Base / Optimism (shared OP-stack predeploy)
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH — Arbitrum
    // USDC
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC — Ethereum mainnet
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC — Base (native)
    // USDT / DAI — Ethereum mainnet
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0', // DAI
  ].map((a) => a.toLowerCase()),
)

// isBaseOrStable() — symbol match is primary (case-insensitive, chain-agnostic, always reliable);
// address match is a secondary check for when a caller only has an address and no trusted symbol
// (e.g. an unresolved/placeholder symbol like "?" or "UNKNOWN" from swapNormalizer's missing-side
// handling). Never throws; an empty/garbage input simply resolves to false (volatile), never true.
export function isBaseOrStable(symbolOrAddress: string): boolean {
  const value = (symbolOrAddress ?? '').trim()
  if (!value) return false
  if (BASE_STABLE_SYMBOLS.has(value.toUpperCase())) return true
  if (value.toLowerCase().startsWith('0x')) return BASE_STABLE_ADDRESSES.has(value.toLowerCase())
  return false
}

function tokenIsBaseOrStable(token: TokenRef): boolean {
  return isBaseOrStable(token.symbol) || isBaseOrStable(token.address)
}

// ─── Classification ──────────────────────────────────────────────────────────

function hopsClause(trade: NormalizedTrade): string {
  return trade.meta.hops > 1 ? ` (multi-hop, ${trade.meta.hops} hops — tokenIn/tokenOut are the first/last leg)` : ''
}

function classifyOne(trade: NormalizedTrade): TradeWithIntent {
  // LP operations pass through as their own intent — never re-derived as BUY/SELL/SWAP, since
  // adding/removing liquidity isn't a directional trade of one asset for another in the sense this
  // engine classifies (same design decision already made in swapNormalizer's own isBuy/isSell).
  if (trade.type === 'LP_ADD') {
    return {
      ...trade,
      intent: 'LP_ADD',
      intentReason: `Liquidity add: supplied ${trade.tokenIn.symbol} for ${trade.tokenOut.symbol} (LP position), not a directional trade.`,
      isBuy: false,
      isSell: false,
    }
  }
  if (trade.type === 'LP_REMOVE') {
    return {
      ...trade,
      intent: 'LP_REMOVE',
      intentReason: `Liquidity remove: burned ${trade.tokenIn.symbol} (LP position) for ${trade.tokenOut.symbol}, not a directional trade.`,
      isBuy: false,
      isSell: false,
    }
  }

  const { missingSide } = trade.meta
  const inIsBase = tokenIsBaseOrStable(trade.tokenIn)
  const outIsBase = tokenIsBaseOrStable(trade.tokenOut)
  const hops = hopsClause(trade)

  // Missing-side cases (swapNormalizer could not resolve one leg): classify from the KNOWN side's
  // role alone — a documented best-effort heuristic on the known side, never a guess at the
  // unresolved token's actual identity (same rule swapNormalizer's own buySellDetector uses).
  if (missingSide === 'tokenOut') {
    if (inIsBase) {
      return {
        ...trade,
        intent: 'BUY',
        intentReason: `Wallet spent a base/stable asset (${trade.tokenIn.symbol}); the received token could not be resolved${hops}, but spending a base/stable asset to acquire an unresolved token is treated as a BUY.`,
        isBuy: true,
        isSell: false,
      }
    }
    return {
      ...trade,
      intent: 'SWAP',
      intentReason: `Wallet spent a volatile token (${trade.tokenIn.symbol}) and the received side could not be resolved${hops}; not confidently a BUY or SELL, classified as a generic SWAP.`,
      isBuy: false,
      isSell: false,
    }
  }

  if (missingSide === 'tokenIn') {
    if (outIsBase) {
      return {
        ...trade,
        intent: 'SELL',
        intentReason: `Wallet received a base/stable asset (${trade.tokenOut.symbol}); the spent token could not be resolved${hops}, but receiving a base/stable asset for an unresolved token is treated as a SELL.`,
        isBuy: false,
        isSell: true,
      }
    }
    return {
      ...trade,
      intent: 'SWAP',
      intentReason: `Wallet received a volatile token (${trade.tokenOut.symbol}) and the spent side could not be resolved${hops}; not confidently a BUY or SELL, classified as a generic SWAP.`,
      isBuy: false,
      isSell: false,
    }
  }

  // Both sides resolved.
  if (inIsBase && !outIsBase) {
    return {
      ...trade,
      intent: 'BUY',
      intentReason: `Spent base/stable ${trade.tokenIn.symbol} to receive volatile ${trade.tokenOut.symbol}${hops}.`,
      isBuy: true,
      isSell: false,
    }
  }
  if (outIsBase && !inIsBase) {
    return {
      ...trade,
      intent: 'SELL',
      intentReason: `Sent volatile ${trade.tokenIn.symbol} to receive base/stable ${trade.tokenOut.symbol}${hops}.`,
      isBuy: false,
      isSell: true,
    }
  }
  // Both base/stable, or both volatile — neither a clean BUY nor a clean SELL.
  const reason = inIsBase && outIsBase
    ? `Both sides (${trade.tokenIn.symbol} -> ${trade.tokenOut.symbol}) are base/stable assets${hops}; classified as a generic SWAP, not a directional trade.`
    : `Both sides (${trade.tokenIn.symbol} -> ${trade.tokenOut.symbol}) are volatile tokens, neither clearly base/stable${hops}; classified as a generic SWAP.`
  return { ...trade, intent: 'SWAP', intentReason: reason, isBuy: false, isSell: false }
}

// Public entry point. Pure: same input always produces the same output, no I/O, no randomness.
// Never throws — a malformed trade (missing type, unexpected shape) would only ever come from an
// upstream swapNormalizer bug, and this engine trusts that contract rather than re-validating it.
export function classifyTradeIntent(trades: NormalizedTrade[]): TradeWithIntent[] {
  return trades.map(classifyOne)
}

// ─── Worked examples (illustrative only — see intentEngine.test.ts for executable versions) ───
//
// 1. PURE BUY — USDC -> DEGEN, single hop, both sides resolved:
//    tokenIn={symbol:"USDC"}, tokenOut={symbol:"DEGEN"}, meta.missingSide="none", meta.hops=1
//    -> intent="BUY", isBuy=true, isSell=false
//
// 2. PURE SELL — DEGEN -> USDC, single hop:
//    tokenIn={symbol:"DEGEN"}, tokenOut={symbol:"USDC"}, meta.missingSide="none", meta.hops=1
//    -> intent="SELL", isBuy=false, isSell=true
//
// 3. VOLATILE -> VOLATILE SWAP — DEGEN -> BRETT:
//    tokenIn={symbol:"DEGEN"}, tokenOut={symbol:"BRETT"}, meta.missingSide="none"
//    -> intent="SWAP", isBuy=false, isSell=false
//
// 4. LP_ADD passthrough — USDC + WETH supplied for an LP token:
//    trade.type="LP_ADD", tokenIn={symbol:"USDC"}, tokenOut={symbol:"LP"}
//    -> intent="LP_ADD", isBuy=false, isSell=false
//
// 5. LP_REMOVE passthrough — LP token burned for USDC:
//    trade.type="LP_REMOVE", tokenIn={symbol:"LP"}, tokenOut={symbol:"USDC"}
//    -> intent="LP_REMOVE", isBuy=false, isSell=false
//
// 6. MULTI-HOP BUY with a missing final leg — USDC -> [unresolved], 3 hops:
//    tokenIn={symbol:"USDC"}, tokenOut=UNKNOWN_TOKEN, meta.missingSide="tokenOut", meta.hops=3
//    -> intent="BUY" (best-effort from the known base/stable side), isBuy=true, isSell=false
