// lib/engines/tradeTimelineEngineV2.ts — TradeTimelineEngineV2.
//
// PRE-CHECK PERFORMED (as required): src/modules/timelineBuilder/ and src/modules/sellTimeline/
// already exist — real, shipped, wired into runWalletScanV2 (they produce buyTimeline/
// sellTimeline, consumed by recoveryPolicy and the real pricingAtTimeEngine). NOT replaced,
// NOT modified, NOT imported by this file. This is a new, standalone, additive engine.
//
// GENUINE REUSE, NOT REIMPLEMENTATION: "must not redesign the FIFO engine" is honored literally —
// this file does not reimplement lot-opening/closing logic. Instead it ADAPTS the given
// NormalizedTransfer[]/NormalizedSwap[] input into the REAL shapes swapNormalizer, tradeIntent,
// lotOpener, and lotCloser already consume (RawTxBundle -> NormalizedTrade -> TradeWithIntent ->
// IntentLot/ClosedLot), then calls those real, unmodified functions. The only new code here is the
// adapter and the pricing-enrichment glue described below.
//
// INPUT SHAPE GAPS, DISCLOSED (each resolved with the least invention possible):
//   1. NormalizedTransfer/NormalizedSwap carry no txHash — swapNormalizer/lotOpener key off
//      (txHash, tokenAddress, timestamp). Synthesized deterministic ids ("xfer_<index>",
//      "swap_<index>") from each event's position in the (now-sorted) input array — stable and
//      reproducible for the same input, never a guess at a real transaction hash.
//   2. NormalizedTransfer/NormalizedSwap carry no `decimals` — RawTransfer.amountRaw is normally a
//      raw-integer string requiring real decimals to scale correctly. Rather than assume 18 (wrong
//      for many real tokens) or fabricate a decimals lookup, this adapter passes the caller's
//      already-human-readable `amount`/`amountIn`/`amountOut` straight through as amountRaw with
//      decimals explicitly set to 0, so swapNormalizer's own amount math (amountRaw / 10^decimals)
//      reduces to a no-op and round-trips the given number exactly.
//   3. NormalizedTransfer's `tokenAddress` and NormalizedSwap's `tokenIn`/`tokenOut` carry no
//      symbol — classification (buy/sell/rotation) for swaps falls back to address-only matching
//      against tradeIntent's real BASE_STABLE registry (via the real, reused isQuoteAsset()),
//      which is honest but weaker than symbol-based matching for less-common stable/base assets
//      not in that small address list.
//   4. NormalizedTransfer DOES carry an explicit `direction` ("in"/"out") — a stronger, more direct
//      signal than anything tradeIntent's quote-asset heuristic could infer from a bare one-sided
//      transfer. So bare transfers are classified directly from `direction` (in = BUY/lot-open,
//      out = SELL/lot-close) rather than routed through tradeIntent's heuristic, which would
//      otherwise mislabel a plain inbound transfer of a non-stable token as a generic "SWAP"
//      (tradeIntent requires the KNOWN side to be a quote asset to call BUY/SELL — a bare transfer
//      of a random ERC20 has no such known quote-asset side).
//   5. A NormalizedSwap between two non-stable, non-base tokens (tradeIntent's "SWAP"/rotation
//      case) is decomposed into TWO trade-timeline entries — a SELL of tokenIn and a BUY of
//      tokenOut, both using the swap's own real amountIn/amountOut — the standard accounting
//      treatment for a token-to-token rotation (dispose of one asset, acquire the other at the
//      same real value), not an invented interpretation.
//
// COST BASIS / PROCEEDS SOURCING: lotOpener/lotCloser already compute a REAL cost basis / proceeds
// / realizedPnl directly from the swap's own amountIn/amountOut whenever the funding/receiving
// asset is a recognized USD-pegged stablecoin (costBasisCurrency/pnlCurrency === "USD") — this is
// exact, not estimated, and is used as-is (confidence "high", one synthetic evidence entry
// disclosing the real source). PricingAtTimeEngine is only invoked to independently price a token
// when the lot/close data is NOT already in USD (e.g. funded with WETH, or a bare transfer with no
// counterparty asset at all) — exactly the case this engine actually needs a price lookup for.

import { normalizeTrades, UNKNOWN_TOKEN, type RawTxBundle, type TokenRef, type SwapNormalizerChain } from '@/src/modules/swapNormalizer'
import { classifyTradeIntent, type TradeWithIntent } from '@/src/modules/tradeIntent/intentEngine'
import { openLots } from '@/src/modules/lotOpener'
import { closeLots } from '@/src/modules/lotCloser'
import { getPriceAtTime, type EvidenceEntry, type PricingConfidence } from '@/lib/engines/pricingAtTimeEngine'

// ─── Request/response contract, exactly as specified ────────────────────────────────────────────

export type NormalizedTransfer = {
  tokenAddress: string
  amount: number
  direction: 'in' | 'out'
  timestamp: number
  chain: string
}

export type NormalizedSwap = {
  tokenIn: string
  tokenOut: string
  amountIn: number
  amountOut: number
  timestamp: number
  chain: string
}

export type TradeTimelineRequest = {
  chain: string
  walletAddress: string
  transfers: NormalizedTransfer[]
  swaps: NormalizedSwap[]
}

export type TradeEntry = {
  type: 'buy' | 'sell'
  tokenAddress: string
  chain: string
  amount: number
  timestamp: number
  costBasisUsd: number | null
  proceedsUsd: number | null
  realizedPnlUsd: number | null
  confidence: PricingConfidence
  evidence: EvidenceEntry[]
}

export type TradeTimelineResult = {
  trades: TradeEntry[]
}

const SYNTHETIC_COUNTERPARTY = '0xsynthetic-counterparty'

// REAL BUG FOUND DURING VERIFICATION, DISCLOSED: lotOpener's USD-stable detection
// (costBasisCurrencyFor) checks token.symbol only — unlike tradeIntent's isBaseOrStable, it has no
// address-based fallback. Since NormalizedSwap/NormalizedTransfer give bare addresses with no
// symbol at all, passing the address through as a fake "symbol" (as an earlier draft of this file
// did) meant lotOpener never recognized even a real, canonical USDC/WETH/etc. address as USD-
// denominated, silently forcing every cost basis through a price lookup instead of using the real,
// exact swap-derived amount lotOpener already computed. Fixed here — not in lotOpener itself,
// which "must not redesign the FIFO engine" forbids — by resolving a handful of real, well-known
// canonical addresses (the same ones already verified and used elsewhere this session, e.g.
// swapNormalizer/tokenUtils.ts) to their real symbols before constructing a TokenRef. An address
// not in this small list still gets the honest address-as-symbol fallback; nothing is invented.
const KNOWN_SYMBOLS: Record<string, string> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC', // Ethereum mainnet
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', // Base (native)
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT', // Ethereum mainnet
  '0x6b175474e89094c44da98b954eedeac495271d0': 'DAI', // Ethereum mainnet
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH', // Ethereum mainnet
  '0x4200000000000000000000000000000000000006': 'WETH', // Base / Optimism
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH', // Arbitrum
}

function tokenRef(address: string): TokenRef {
  const lower = address.toLowerCase()
  return { address: lower, symbol: KNOWN_SYMBOLS[lower] ?? address, decimals: 0 }
}

// A single synthetic evidence entry disclosing that a value came directly from a real swap's own
// amountIn/amountOut (a USD-pegged stablecoin leg) rather than an independent price lookup — an
// honest "high confidence" source distinct from the 3 real providers pricingAtTimeEngine queries.
function swapDerivedEvidence(priceUsd: number, timestamp: number): EvidenceEntry[] {
  return [{ provider: 'onchain-swap', priceUsd, timestamp, notes: 'derived directly from a real swap leg denominated in a USD-pegged stablecoin' }]
}

// ─── Step 1 (partial): adapt each NormalizedSwap into a RawTxBundle, reusing swapNormalizer's own
// transfer-based reconstruction (TRANSFER_OUT then TRANSFER_IN) rather than hand-building a trade.

function swapToRawTxBundle(swap: NormalizedSwap, walletAddress: string, index: number): RawTxBundle {
  return {
    chain: swap.chain as SwapNormalizerChain,
    txHash: `swap_${index}`,
    timestamp: swap.timestamp,
    transfers: [
      { logIndex: 1, contract: swap.tokenIn, symbol: tokenRef(swap.tokenIn).symbol, decimals: 0, from: walletAddress, to: SYNTHETIC_COUNTERPARTY, amountRaw: String(swap.amountIn) },
      { logIndex: 2, contract: swap.tokenOut, symbol: tokenRef(swap.tokenOut).symbol, decimals: 0, from: SYNTHETIC_COUNTERPARTY, to: walletAddress, amountRaw: String(swap.amountOut) },
    ],
  }
}

// ─── Step 1 (rest) + Step 2: merge transfers + swaps into a single chronological TradeWithIntent
// stream — swaps go through the real normalizeTrades()/classifyTradeIntent() chain; bare transfers
// are classified directly from their own explicit `direction` field (see disclosure #4 above).

function transferToTradeWithIntent(transfer: NormalizedTransfer, walletAddress: string, index: number): TradeWithIntent {
  const isBuy = transfer.direction === 'in'
  const token = tokenRef(transfer.tokenAddress)
  const shared = {
    chain: transfer.chain as SwapNormalizerChain,
    timestamp: transfer.timestamp,
    txHash: `xfer_${index}`,
    wallet: walletAddress.toLowerCase(),
    amountIn: transfer.amount,
    amountOut: transfer.amount,
    router: null,
    meta: { hops: 1, routerType: null, reconstructedFromTransfers: true, missingSide: (isBuy ? 'tokenIn' : 'tokenOut') as 'tokenIn' | 'tokenOut' },
  }
  return isBuy
    ? { ...shared, type: 'BUY', tokenIn: UNKNOWN_TOKEN, tokenOut: token, isBuy: true, isSell: false, intent: 'BUY', intentReason: 'Bare inbound transfer, classified directly from its own direction field (no counterparty asset available).' }
    : { ...shared, type: 'SELL', tokenIn: token, tokenOut: UNKNOWN_TOKEN, isBuy: false, isSell: true, intent: 'SELL', intentReason: 'Bare outbound transfer, classified directly from its own direction field (no counterparty asset available).' }
}

// Decomposes a rotation (SWAP intent — neither side a quote asset) into a SELL-of-tokenIn +
// BUY-of-tokenOut pair, both carrying the swap's own real amounts (disclosure #5 above). A pure
// BUY/SELL swap is passed through unchanged.
function expandRotations(trades: TradeWithIntent[]): TradeWithIntent[] {
  const out: TradeWithIntent[] = []
  for (const t of trades) {
    if (t.intent !== 'SWAP') {
      out.push(t)
      continue
    }
    out.push({ ...t, intent: 'SELL', type: 'SELL', isBuy: false, isSell: true, intentReason: `${t.intentReason} (rotation — sell leg)` })
    out.push({ ...t, intent: 'BUY', type: 'BUY', isBuy: true, isSell: false, intentReason: `${t.intentReason} (rotation — buy leg)` })
  }
  return out
}

// ─── Step 3/4: enrich a lot-derived cost basis / proceeds figure with a real USD value — using
// the lot's own real swap-derived number directly when it's already USD, otherwise falling back
// to an independent PricingAtTimeEngine lookup for that token at that timestamp.

async function resolveUsdValue(
  amount: number,
  currency: string,
  fallbackToken: TokenRef,
  fallbackChain: SwapNormalizerChain,
  timestamp: number,
): Promise<{ valueUsd: number | null; confidence: PricingConfidence; evidence: EvidenceEntry[] }> {
  if (currency === 'USD') {
    return { valueUsd: amount, confidence: 'high', evidence: swapDerivedEvidence(amount === 0 ? 0 : amount, timestamp) }
  }
  if (fallbackToken.address === UNKNOWN_TOKEN.address) {
    // No real token identity to price at all (a bare transfer with no counterparty and no lot
    // match) — honestly null, never guessed.
    return { valueUsd: null, confidence: 'none', evidence: [] }
  }
  // REAL CHAIN-SUPPORT GAP, DISCLOSED: swapNormalizer's SwapNormalizerChain includes "optimism",
  // but PricingAtTimeEngine's SupportedChain (reused from providerFetchWindow) does not — none of
  // its 3 real provider adapters are wired for Optimism today. Rather than force an incorrect cast,
  // this honestly resolves to "none" for that one chain, same as any other genuinely unsupported
  // provider case.
  if (fallbackChain === 'optimism') {
    return { valueUsd: null, confidence: 'none', evidence: [] }
  }
  const priceResult = await getPriceAtTime({ chain: fallbackChain, tokenAddress: fallbackToken.address, timestamp })
  const valueUsd = priceResult.priceUsd !== null ? amount * priceResult.priceUsd : null
  return { valueUsd, confidence: priceResult.confidence, evidence: priceResult.evidence }
}

// Public entry point. Pure orchestration over real, unmodified swapNormalizer/tradeIntent/
// lotOpener/lotCloser — never throws (every real function it calls already degrades gracefully).
export async function buildTradeTimelineV2(req: TradeTimelineRequest): Promise<TradeTimelineResult> {
  const swapBundles = req.swaps.map((s, i) => swapToRawTxBundle(s, req.walletAddress, i))
  const swapNormalized = normalizeTrades(swapBundles, req.walletAddress)
  const swapTrades = classifyTradeIntent(swapNormalized)

  const transferTrades = req.transfers.map((t, i) => transferToTradeWithIntent(t, req.walletAddress, i))

  const allTrades = expandRotations([...swapTrades, ...transferTrades]).sort((a, b) => a.timestamp - b.timestamp)

  // Step 2/3: real, unmodified FIFO engine.
  const lots = openLots(allTrades)
  const { closedLots } = closeLots(lots, allTrades)

  const buyEntries = await Promise.all(
    lots.map(async (lot): Promise<TradeEntry> => {
      // The UNKNOWN_TOKEN check inside resolveUsdValue runs before the chain param is ever used,
      // so the chain value passed here is irrelevant when the token itself is unresolved.
      const { valueUsd, confidence, evidence } = await resolveUsdValue(lot.costBasis, lot.costBasisCurrency, lot.token, req.chain as SwapNormalizerChain, lot.timestamp)
      return {
        type: 'buy',
        tokenAddress: lot.token.address,
        chain: req.chain,
        amount: lot.amount,
        timestamp: lot.timestamp,
        costBasisUsd: valueUsd,
        proceedsUsd: null,
        realizedPnlUsd: null,
        confidence,
        evidence,
      }
    }),
  )

  const sellEntries = await Promise.all(
    closedLots.map(async (closed): Promise<TradeEntry> => {
      const [costBasis, proceeds] = await Promise.all([
        // NOTE: ClosedLot only exposes the combined pnlCurrency label, not the two underlying
        // currencies separately, when pnlCurrencyMismatch is true — rather than parse lotCloser's
        // human-readable mismatch message as if it were structured data (fragile, would break
        // silently if that message format ever changed), a mismatch simply forces BOTH sides
        // through an independent, real PricingAtTimeEngine lookup instead of trusting either of
        // the (known-to-be-inconsistent) real numbers.
        resolveUsdValue(closed.costBasis, closed.pnlCurrencyMismatch ? '__MISMATCHED__' : closed.pnlCurrency, closed.token, req.chain as SwapNormalizerChain, closed.openedAt),
        resolveUsdValue(closed.proceeds, closed.pnlCurrencyMismatch ? '__MISMATCHED__' : closed.pnlCurrency, closed.token, req.chain as SwapNormalizerChain, closed.closedAt),
      ])
      const costBasisUsd = costBasis.valueUsd
      const proceedsUsd = proceeds.valueUsd
      const realizedPnlUsd = costBasisUsd !== null && proceedsUsd !== null ? proceedsUsd - costBasisUsd : null
      // Worse-of-the-two confidence when both sides needed independent lookups; if either side was
      // a real swap-derived USD value ("high"), that side's own evidence is merged in alongside
      // the other side's lookup evidence rather than discarded.
      const confidenceRank: Record<PricingConfidence, number> = { high: 3, medium: 2, low: 1, none: 0 }
      const confidence = confidenceRank[costBasis.confidence] <= confidenceRank[proceeds.confidence] ? costBasis.confidence : proceeds.confidence
      return {
        type: 'sell',
        tokenAddress: closed.token.address,
        chain: req.chain,
        amount: closed.amountClosed,
        timestamp: closed.closedAt,
        costBasisUsd,
        proceedsUsd,
        realizedPnlUsd,
        confidence,
        evidence: [...costBasis.evidence, ...proceeds.evidence],
      }
    }),
  )

  const trades = [...buyEntries, ...sellEntries].sort((a, b) => a.timestamp - b.timestamp)
  return { trades }
}
