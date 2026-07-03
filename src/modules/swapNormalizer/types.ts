// MODULE — swapNormalizer: type definitions.
//
// STANDALONE, NOT WIRED INTO THE PIPELINE. This is a new module built to spec, additive only
// (no existing file modified, no src/pipeline/index.ts or runWalletScanV2.ts changes). It does not
// reuse or overwrite src/modules/normalization/ — that is a real, already-shipped, numbered
// architecture module ("MODULE 2 — normalization") that validates/dedupes/direction-classifies
// single-transfer RawProviderEvent[] into NormalizedEvent[]. It has nothing to do with swap
// pairing, router detection, multi-hop combination, or LP detection, so this module was given its
// own directory/name to avoid colliding with it.
//
// INPUT-SHAPE DISCLOSURE: the spec describes input as "raw events shaped like Covalent's: dex_swaps,
// transfers, logs, metadata, token info, router addresses, wallet address". This codebase's real
// GoldRush/Covalent fetchers (src/modules/providerFetchWindow/utils.ts) do not currently parse or
// expose a `dex_swaps` field or raw `logs` — they only produce a flat RawProviderEvent (one ERC20/
// native transfer per entry). There is no live wiring today that would populate the richer
// `dexSwaps`/`logs`/`poolMetadata` fields defined below with real data. This module's input type is
// therefore a deliberately-designed superset contract: it accepts the richer per-transaction shape
// described in the spec (so a future fetcher upgrade can populate it directly), AND is required to
// keep working using only `transfers` when the richer fields are absent — which is also exactly
// what "Must work even when Covalent misses one side of the swap" and "Handle internal transfers"
// require. Every field below is a plain, real data shape (addresses, raw integer strings, log
// indices) — nothing here fabricates a specific token identity or amount; unresolved sides fall
// back to an explicit UNKNOWN placeholder (see buySellDetector.ts), never a guessed real token.

export type SwapNormalizerChain = 'base' | 'eth' | 'arbitrum' | 'optimism'

export type TokenRef = {
  address: string
  symbol: string
  decimals: number
}

// One ERC20/native transfer inside a transaction. `logIndex` orders transfers within the same tx —
// required for deterministic multi-hop reconstruction and for picking a stable "first" leg when
// several transfers tie on every other field.
export type RawTransfer = {
  logIndex: number
  contract: string
  symbol?: string | null
  decimals?: number | null
  from: string
  to: string
  amountRaw: string
  isLpToken?: boolean | null
}

// One already-decoded DEX swap leg, when a provider supplies it directly (e.g. Covalent's dex_swaps
// endpoint, or a future decoded-log pipeline). When present, this is authoritative and is used
// instead of reconstructing swap legs from `transfers`.
export type RawDexSwap = {
  logIndex: number
  router?: string | null
  poolAddress?: string | null
  tokenIn: TokenRef
  tokenOut: TokenRef
  amountIn: string
  amountOut: string
}

// A raw, undecoded event log — accepted for forward-compatibility with the spec's "logs" input,
// but this module does not attempt ABI decoding of raw logs (out of scope: that would require a
// full per-router ABI registry). Present only so a bundle can carry them without being rejected;
// swap/LP detection here always goes through `dexSwaps` (if present) or `transfers` (the fallback).
export type RawLog = {
  logIndex: number
  address: string
  topics?: string[] | null
  data?: string | null
}

// Pool/LP metadata, when a provider can supply it (e.g. from a GoldRush pool lookup). Used by
// lpAddRemoveDetector to recognize an LP token's mint/burn side without needing an on-chain call.
export type PoolMetadata = {
  poolAddress: string
  lpTokenAddress?: string | null
  token0?: string | null
  token1?: string | null
}

// One on-chain transaction's raw data, exactly the grouping unit normalizeTrades() consumes.
export type RawTxBundle = {
  chain: SwapNormalizerChain
  txHash: string
  timestamp: number
  router?: string | null
  dexSwaps?: RawDexSwap[]
  transfers?: RawTransfer[]
  logs?: RawLog[]
  poolMetadata?: PoolMetadata[]
}

export type TradeType = 'SWAP' | 'BUY' | 'SELL' | 'LP_ADD' | 'LP_REMOVE'

export type NormalizedTrade = {
  type: TradeType
  chain: SwapNormalizerChain
  timestamp: number
  txHash: string
  wallet: string
  tokenIn: TokenRef
  tokenOut: TokenRef
  amountIn: number
  amountOut: number
  router: string | null
  isBuy: boolean
  isSell: boolean
  // Additive diagnostics — not part of the spec's required shape, never required by a consumer.
  // Kept because "no wrong directions" / "no chain-specific bugs" are much easier to audit when the
  // reconstruction path is visible, and because dropping data a consumer doesn't ask for is cheaper
  // than being unable to explain a classification later.
  meta: {
    hops: number
    routerType: string | null
    reconstructedFromTransfers: boolean
    missingSide: 'none' | 'tokenIn' | 'tokenOut'
  }
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export const UNKNOWN_TOKEN: TokenRef = { address: '', symbol: 'UNKNOWN', decimals: 18 }
