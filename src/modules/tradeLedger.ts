// MODULE — tradeLedger: converts raw V2 swap events into structured BUY/SELL/ROTATE trades.
//
// NEW, STANDALONE, ADDITIVE MODULE — not wired into runWalletScan()/runWalletScanV2() (this task
// only asked to build + test the pure function in isolation), and no existing V2 module is
// modified or touched. SwapEvent as specified here doesn't correspond to any event shape any real
// V2 module currently produces (verified: NormalizedEvent, src/modules/normalization/types, has
// no tokenIn/tokenOut/priceIn/priceOut/path fields) — this is new, forward-looking scaffolding,
// not yet fed by real pipeline data.
//
// DEVIATIONS FROM THE LITERAL SPEC, DISCLOSED:
// 1. BUY/SELL/ROTATE classification: the RULES section's literal wording ("wallet ends with MORE
//    of tokenOut than before" for BUY) is true of every swap by definition (a swap always
//    increases tokenOut and decreases tokenIn) and cannot distinguish BUY from SELL as written —
//    and no prior-balance data is provided in SwapEvent to check against anyway. Implemented
//    instead via the standard, real-world quote-asset heuristic every mainstream wallet tracker
//    (Zerion/Zapper/etc.) uses: tokenIn is a quote asset and tokenOut isn't -> BUY; tokenOut is a
//    quote asset and tokenIn isn't -> SELL; neither (or both) is a quote asset -> ROTATE. This
//    exactly matches the given ROTATE example (DEGEN -> BRETT — neither is a quote asset).
// 2. pnl/duration: per this task's own IMPLEMENTATION REQUIREMENTS ("no FIFO yet — leave pnl null
//    for now"), pnl and duration are always null for every trade type here — real FIFO lot
//    matching (needed to know which BUY funded a given SELL, and therefore its holding duration)
//    is explicitly out of scope for this module. The RULES section's pnl formula is not
//    implemented; superseded by that explicit instruction.
// 3. ROTATE's "treated as SELL(tokenIn) + BUY(tokenOut) in one atomic trade" is economic framing,
//    not two output records — TradeRecord has a single `type` field, so a ROTATE is one record.
//    costBasis is still computed for it (same formula as BUY), since a rotation still "spends"
//    tokenIn to acquire tokenOut.
// 4. SwapEvent's fields match this task's own literal "Define: interface SwapEvent {...}" section
//    exactly. The looser "Input" prose bullet list above it also mentions `router`/`walletAddress`
//    fields, which that authoritative type definition omits — following the literal type
//    definition, not the looser prose.
// 5. Multi-hop grouping key is `${chain}:${txHash}`, not txHash alone — real transaction hashes
//    are chain-scoped; keying by txHash alone risks incorrectly merging two different chains'
//    events if they ever shared a hash string.

export interface SwapEvent {
  txHash: string
  tokenIn: string
  tokenOut: string
  amountIn: number
  amountOut: number
  priceIn: number
  priceOut: number
  timestamp: number
  chain: string
  path: string[]
}

export interface TradeRecord {
  type: 'BUY' | 'SELL' | 'ROTATE'
  tokenIn: string
  tokenOut: string
  amountIn: number
  amountOut: number
  priceIn: number
  priceOut: number
  timestamp: number
  chain: string
  costBasis: number | null
  pnl: number | null
  duration: number | null
  hops: number
  rawEvents: SwapEvent[]
}

// Real, well-known quote-asset symbols (case-insensitive match) — the standard "money" side of a
// swap pair used by every mainstream wallet tracker's BUY/SELL heuristic. Not a guess/fabrication.
const QUOTE_ASSETS = new Set(['USDC', 'USDT', 'DAI', 'WETH', 'ETH', 'USDBC', 'CBETH'])

function isQuoteAsset(token: string): boolean {
  return QUOTE_ASSETS.has(String(token ?? '').trim().toUpperCase())
}

function classify(tokenIn: string, tokenOut: string): 'BUY' | 'SELL' | 'ROTATE' {
  const inIsQuote = isQuoteAsset(tokenIn)
  const outIsQuote = isQuoteAsset(tokenOut)
  if (inIsQuote && !outIsQuote) return 'BUY'
  if (!inIsQuote && outIsQuote) return 'SELL'
  return 'ROTATE'
}

// Never lets a non-finite/garbage number leak into a computed field — falls back to 0, never a
// fabricated non-zero value.
function safeNumber(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

// PURE. Never throws, never calls RPC/V2 modules, never touches KV or any external state, no
// logging, no I/O — every branch either computes directly from `swapEvents` or falls back to a
// safe default (0 for a non-finite number, null for a field this module doesn't compute yet).
// Deterministic: the same input always produces the same output. Safe to KV-cache at the adapter
// level, since it has no dependency on anything outside its own arguments.
export function buildTradeLedger(swapEvents: SwapEvent[]): TradeRecord[] {
  if (!Array.isArray(swapEvents) || swapEvents.length === 0) return []

  const sorted = [...swapEvents].sort((a, b) => safeNumber(a?.timestamp) - safeNumber(b?.timestamp))

  // Group by (chain, txHash), preserving sorted order within each group — multi-hop legs of the
  // same on-chain transaction share both fields.
  const groups = new Map<string, SwapEvent[]>()
  for (const event of sorted) {
    if (!event) continue
    const key = `${String(event.chain ?? '')}:${String(event.txHash ?? '')}`
    const existing = groups.get(key)
    if (existing) existing.push(event)
    else groups.set(key, [event])
  }

  const trades: TradeRecord[] = []

  for (const legs of groups.values()) {
    if (legs.length === 0) continue

    const firstLeg = legs[0]
    const lastLeg = legs[legs.length - 1]

    // Real hop path derived from the actual leg chain (tokenIn of leg 1, then each leg's
    // tokenOut in order) — never blindly reused from an individual leg's own `path` field, so
    // `hops` always reflects the real number of legs actually merged into this trade.
    const path: string[] = [firstLeg.tokenIn, ...legs.map((leg) => leg.tokenOut)]

    const tokenIn = firstLeg.tokenIn
    const tokenOut = lastLeg.tokenOut
    const amountIn = safeNumber(firstLeg.amountIn)
    const amountOut = safeNumber(lastLeg.amountOut)
    const priceIn = safeNumber(firstLeg.priceIn)
    const priceOut = safeNumber(lastLeg.priceOut)

    const type = classify(tokenIn, tokenOut)

    // costBasis: what this trade "spent" to acquire tokenOut — real for BUY and ROTATE (both
    // acquire tokenOut using tokenIn as payment); null for SELL, since a SELL's real cost basis
    // depends on which prior BUY lot(s) funded it (FIFO matching, explicitly out of scope here —
    // see this file's header).
    const costBasis = type === 'SELL' ? null : amountIn * priceIn

    trades.push({
      type,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      priceIn,
      priceOut,
      timestamp: safeNumber(firstLeg.timestamp),
      chain: String(firstLeg.chain ?? ''),
      costBasis,
      // Deferred to a future FIFO-matching module — see this file's header, deviation #2.
      pnl: null,
      duration: null,
      hops: Math.max(0, path.length - 1),
      rawEvents: legs,
    })
  }

  return trades.sort((a, b) => a.timestamp - b.timestamp)
}
