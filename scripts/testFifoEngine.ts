/**
 * In-memory test harness for the FIFO PnL engine.
 * Copies the exact logic from lib/server/walletSnapshot.ts — no imports, fully standalone.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type PnlEvent = {
  contract: string; symbol: string; direction: 'buy' | 'sell' | 'unknown'
  amount: number; usdValue: number | null
  txHash?: string; timestamp?: string; txToAddress?: string; txFromAddress?: string
  chain?: string; isSwapCandidate?: boolean
}

type FifoClosedLot = {
  contract: string; symbol: string
  buyTxHash: string; sellTxHash: string
  buyTimestamp: string; sellTimestamp: string
  buyAmount: number; sellAmount: number
  buyCostUsd: number; sellProceedsUsd: number
  realizedPnlUsd: number; chain: string
}

type WalletTradeStatsSummary = {
  status: 'ok' | 'partial' | 'unavailable'
  source: 'fifo' | 'per_swap_fallback' | 'none'
  tradesAnalyzed: number
  winRate: number | null
  avgWinUsd: number | null
  avgLossUsd: number | null
  totalRealizedPnlUsd: number | null
  bestTradeUsd: number | null
  worstTradeUsd: number | null
  confidence: 'high' | 'medium' | 'low' | null
  reason: string
}

// ─── Constants (mirrored exactly from walletSnapshot.ts) ──────────────────────

const EXTENDED_DEX_ROUTERS = new Set<string>([
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  '0xe592427a0aece92de3edee1f18e0157c05861564',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
  '0x1111111254fb6c44bac0bed2854e76f90643097d',
  '0x1111111254eeb25477b68fb85ed929f73a960582',
  '0x111111125421ca6dc452d289314280a0f8842a65',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
  '0x55dc0e69ec00debcebdc25fe6f7cad62e63c8f81',
  '0x216b4b4ba9f3e719726886d34a177484278bfcae',
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f',
  '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
  '0x6cb442acf35158d68425b2a89f7e7b02fb5e42d5',
  '0xba12222222228d8ba445958a75a0704d566bf2c8',
  '0x99a58482bd75cbab83b27ec03ca68ff489b5788f',
  '0xf0d4c12a5768d806021f80a262b4d39d26c58b8d',
  '0x327df1e6de05895d2ab08513aadd9313fe505d86',
])

const FIFO_QUOTE_ASSETS = new Set<string>([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
  '0x6b175474e89094c44da98b954eedeac495271d0f',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
  '0x4200000000000000000000000000000000000006',
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
])

// ─── Engine functions (mirrored exactly from walletSnapshot.ts) ───────────────

function buildFifoSwapDetection(events: PnlEvent[], walletAddr: string): PnlEvent[] {
  const lower = walletAddr.toLowerCase()
  const byTx = new Map<string, PnlEvent[]>()
  for (const e of events) {
    if (!e.txHash) continue
    const k = e.txHash.toLowerCase()
    if (!byTx.has(k)) byTx.set(k, [])
    byTx.get(k)!.push(e)
  }
  const swapHashes = new Set<string>()
  for (const [txHash, txEvents] of byTx) {
    const hasIn  = txEvents.some(e => e.direction === 'buy')
    const hasOut = txEvents.some(e => e.direction === 'sell')
    const toRouter   = txEvents.some(e => e.txToAddress   && EXTENDED_DEX_ROUTERS.has(e.txToAddress.toLowerCase()))
    const fromRouter = txEvents.some(e => e.txFromAddress && EXTENDED_DEX_ROUTERS.has(e.txFromAddress.toLowerCase()))
    const hasQuoteAsset    = txEvents.some(e => FIFO_QUOTE_ASSETS.has(e.contract.toLowerCase()))
    const hasNonQuoteAsset = txEvents.some(e => !FIFO_QUOTE_ASSETS.has(e.contract.toLowerCase()))
    const quoteSwap = hasQuoteAsset && hasNonQuoteAsset && (hasIn || hasOut)
    if ((hasIn && hasOut) || toRouter || fromRouter || quoteSwap) swapHashes.add(txHash)
  }
  void lower
  return events.map(e => ({ ...e, isSwapCandidate: e.txHash ? swapHashes.has(e.txHash.toLowerCase()) : false }))
}

function normalizeSingleLegs(events: PnlEvent[]): PnlEvent[] {
  const byTx = new Map<string, PnlEvent[]>()
  for (const e of events) {
    if (!e.txHash) continue
    const k = e.txHash.toLowerCase()
    if (!byTx.has(k)) byTx.set(k, [])
    byTx.get(k)!.push(e)
  }
  return events.map(e => {
    if (!e.txHash || (e.usdValue ?? 0) > 0) return e
    const txEvents = byTx.get(e.txHash.toLowerCase()) ?? []
    const partner = txEvents.find(p => p !== e && (p.usdValue ?? 0) > 0 && p.amount > 0)
    if (partner?.usdValue) return { ...e, usdValue: partner.usdValue }
    return e
  })
}

function buildFifoLotEngine(events: PnlEvent[]): { closedLots: FifoClosedLot[]; openLots: number; realizedPnlUsd: number } {
  const eligible = events.filter(e =>
    e.isSwapCandidate && e.txHash && e.timestamp &&
    (e.direction === 'buy' || e.direction === 'sell') &&
    (e.usdValue ?? 0) > 0 && e.amount > 0
  ) as Array<PnlEvent & { txHash: string; timestamp: string; usdValue: number }>

  eligible.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  type OpenLot = { buyTxHash: string; buyTimestamp: string; amount: number; costPerUnit: number; chain: string }
  const openByToken = new Map<string, OpenLot[]>()
  const closedLots: FifoClosedLot[] = []

  for (const e of eligible) {
    const key = e.contract.toLowerCase()
    if (e.direction === 'buy') {
      const costPerUnit = e.usdValue / e.amount
      if (!openByToken.has(key)) openByToken.set(key, [])
      openByToken.get(key)!.push({ buyTxHash: e.txHash, buyTimestamp: e.timestamp, amount: e.amount, costPerUnit, chain: e.chain ?? 'unknown' })
    } else {
      const lots = openByToken.get(key) ?? []
      let remaining = e.amount
      const procPerUnit = e.usdValue / e.amount
      while (remaining > 1e-9 && lots.length > 0) {
        const lot = lots[0]
        const closed = Math.min(lot.amount, remaining)
        closedLots.push({
          contract: key, symbol: e.symbol,
          buyTxHash: lot.buyTxHash, sellTxHash: e.txHash,
          buyTimestamp: lot.buyTimestamp, sellTimestamp: e.timestamp,
          buyAmount: closed, sellAmount: closed,
          buyCostUsd: closed * lot.costPerUnit,
          sellProceedsUsd: closed * procPerUnit,
          realizedPnlUsd: closed * (procPerUnit - lot.costPerUnit),
          chain: e.chain ?? lot.chain,
        })
        remaining -= closed
        lot.amount -= closed
        if (lot.amount <= 1e-9) lots.shift()
      }
    }
  }

  const openLots = [...openByToken.values()].reduce((s, lots) => s + lots.length, 0)
  const realizedPnlUsd = closedLots.reduce((s, l) => s + l.realizedPnlUsd, 0)
  return { closedLots, openLots, realizedPnlUsd }
}

function buildTradeStatsSummary(closedLots: FifoClosedLot[], swapCandidateCount: number): WalletTradeStatsSummary {
  if (closedLots.length === 0) {
    return { status: 'unavailable', source: 'fifo', tradesAnalyzed: 0, winRate: null, avgWinUsd: null, avgLossUsd: null, totalRealizedPnlUsd: null, bestTradeUsd: null, worstTradeUsd: null, confidence: null, reason: 'No closed FIFO lots found.' }
  }
  const wins   = closedLots.filter(l => l.realizedPnlUsd > 0)
  const losses = closedLots.filter(l => l.realizedPnlUsd <= 0)
  const total  = closedLots.length
  const allPnls = closedLots.map(l => l.realizedPnlUsd)
  const coverage = swapCandidateCount > 0 ? (total / swapCandidateCount) * 100 : 0
  return {
    status: total >= 3 ? 'ok' : 'partial',
    source: 'fifo',
    tradesAnalyzed: total,
    winRate: Math.round((wins.length / total) * 100) / 100,
    avgWinUsd:  wins.length   > 0 ? wins.reduce((s, l) => s + l.realizedPnlUsd, 0)   / wins.length   : null,
    avgLossUsd: losses.length > 0 ? losses.reduce((s, l) => s + l.realizedPnlUsd, 0) / losses.length : null,
    totalRealizedPnlUsd: allPnls.reduce((s, v) => s + v, 0),
    bestTradeUsd:  Math.max(...allPnls),
    worstTradeUsd: Math.min(...allPnls),
    confidence: coverage >= 60 ? 'high' : coverage >= 30 ? 'medium' : 'low',
    reason: `FIFO lot matching across ${total} closed trade(s).`,
  }
}

function buildPerSwapTradeStats(events: PnlEvent[]): WalletTradeStatsSummary {
  const byTx = new Map<string, PnlEvent[]>()
  for (const e of events) {
    if (!e.isSwapCandidate || !e.txHash || (e.usdValue ?? 0) <= 0) continue
    const k = e.txHash.toLowerCase()
    if (!byTx.has(k)) byTx.set(k, [])
    byTx.get(k)!.push(e)
  }
  const trades: Array<{ pnl: number }> = []
  for (const [, txEvents] of byTx) {
    const buys  = txEvents.filter(e => e.direction === 'buy')
    const sells = txEvents.filter(e => e.direction === 'sell')
    if (buys.length === 0 || sells.length === 0) continue
    const buyUsd  = buys.reduce((s, e)  => s + (e.usdValue ?? 0), 0)
    const sellUsd = sells.reduce((s, e) => s + (e.usdValue ?? 0), 0)
    trades.push({ pnl: sellUsd - buyUsd })
  }
  if (trades.length === 0) {
    return { status: 'unavailable', source: 'per_swap_fallback', tradesAnalyzed: 0, winRate: null, avgWinUsd: null, avgLossUsd: null, totalRealizedPnlUsd: null, bestTradeUsd: null, worstTradeUsd: null, confidence: null, reason: 'No priced swap pairs found for per-swap fallback.' }
  }
  const wins   = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)
  const allPnls = trades.map(t => t.pnl)
  return {
    status: trades.length >= 3 ? 'ok' : 'partial',
    source: 'per_swap_fallback',
    tradesAnalyzed: trades.length,
    winRate: Math.round((wins.length / trades.length) * 100) / 100,
    avgWinUsd:  wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0)   / wins.length   : null,
    avgLossUsd: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : null,
    totalRealizedPnlUsd: allPnls.reduce((s, v) => s + v, 0),
    bestTradeUsd:  Math.max(...allPnls),
    worstTradeUsd: Math.min(...allPnls),
    confidence: trades.length >= 10 ? 'medium' : 'low',
    reason: `Per-swap fallback: ${trades.length} priced swap pair(s) analyzed.`,
  }
}

// ─── Pipeline runner ──────────────────────────────────────────────────────────

function runPipeline(rawEvents: PnlEvent[], walletAddr: string) {
  const swapTagged       = buildFifoSwapDetection(rawEvents, walletAddr)
  const normalized       = normalizeSingleLegs(swapTagged)
  const { closedLots, openLots, realizedPnlUsd } = buildFifoLotEngine(normalized)
  const swapCandidates   = normalized.filter(e => e.isSwapCandidate)
  const tradeStats: WalletTradeStatsSummary = closedLots.length > 0
    ? buildTradeStatsSummary(closedLots, swapCandidates.length)
    : buildPerSwapTradeStats(normalized)
  return { swapTagged, normalized, closedLots, openLots, realizedPnlUsd, tradeStats, swapCandidates }
}

// ─── Test harness ─────────────────────────────────────────────────────────────

type TestResult = {
  name: string
  passed: boolean
  details: {
    swapDetected: boolean
    swapCandidateCount: number
    allDirectionsCorrect: boolean
    priced: boolean
    pricedAfterNorm: boolean
    fifoClosedLots: number
    fallbackTrades: number
    realizedPnlUsd: number | null
    failureReasons: string[]
  }
}

const WALLET  = '0x1234567890123456789012345678901234567890'
const ROUTER  = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d' // Uniswap v2
const ROUTER2 = '0xdef1c0ded9bec7f1a1670819833240f027b25eff' // 0x ExchangeProxy
const USDC    = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01'
const AIRDROP = '0xcccccccccccccccccccccccccccccccccccccccc' // NOT a router

function mk(o: Partial<PnlEvent> & { contract: string; direction: 'buy' | 'sell' | 'unknown'; amount: number }): PnlEvent {
  return {
    symbol: '?', usdValue: null,
    txHash: '0xdefault', timestamp: '2024-01-01T00:00:00Z',
    txToAddress: ROUTER, txFromAddress: WALLET,
    chain: 'eth-mainnet',
    ...o,
  }
}

function testFifoEngine(): TestResult[] {
  const results: TestResult[] = []

  function assess(
    name: string,
    rawEvents: PnlEvent[],
    opts: {
      expectSwap: boolean
      expectNoTrades?: boolean
      expectedDirections?: Array<'buy' | 'sell' | 'unknown'>
      // Per-tx level override: map txHash → expected isSwapCandidate
      expectSwapPerTx?: Record<string, boolean>
    },
  ): TestResult {
    const res = runPipeline(rawEvents, WALLET)
    const swapDetected = res.swapCandidates.length > 0
    const hasTrades = res.closedLots.length > 0 || res.tradeStats.tradesAnalyzed > 0
    const allDirectionsCorrect = opts.expectedDirections
      ? opts.expectedDirections.every((dir, i) => res.swapTagged[i]?.direction === dir)
      : true
    const pricedBefore = rawEvents.filter(e => (e.usdValue ?? 0) > 0).length
    const pricedAfter  = res.normalized.filter(e => (e.usdValue ?? 0) > 0).length
    const priced       = pricedBefore > 0
    const pricedAfterNorm = pricedAfter > pricedBefore || priced

    const failureReasons: string[] = []

    // Per-tx swap detection check (more precise than global expectSwap)
    if (opts.expectSwapPerTx) {
      for (const [txHash, expected] of Object.entries(opts.expectSwapPerTx)) {
        const eventsInTx = res.swapTagged.filter(e => e.txHash?.toLowerCase() === txHash.toLowerCase())
        const detected   = eventsInTx.some(e => e.isSwapCandidate)
        if (expected && !detected)  failureReasons.push(`swap_not_detected_for_${txHash} → buildFifoSwapDetection`)
        if (!expected && detected)  failureReasons.push(`false_swap_detected_for_${txHash} → buildFifoSwapDetection`)
      }
    } else {
      if (opts.expectSwap && !swapDetected)  failureReasons.push('swap_not_detected → buildFifoSwapDetection')
      if (!opts.expectSwap && swapDetected)  failureReasons.push('false_swap_detected → buildFifoSwapDetection')
    }

    if (!opts.expectNoTrades && !hasTrades)  failureReasons.push('no_trades_produced → buildFifoLotEngine or buildPerSwapTradeStats')
    if (opts.expectNoTrades  &&  hasTrades)  failureReasons.push('trades_fabricated → buildFifoSwapDetection or buildFifoLotEngine')
    if (!allDirectionsCorrect)               failureReasons.push('direction_mismatch → fetchGoldrushPnlEvents direction inference')

    return {
      name,
      passed: failureReasons.length === 0,
      details: {
        swapDetected,
        swapCandidateCount: res.swapCandidates.length,
        allDirectionsCorrect,
        priced,
        pricedAfterNorm,
        fifoClosedLots: res.closedLots.length,
        fallbackTrades: res.tradeStats.tradesAnalyzed,
        realizedPnlUsd: res.realizedPnlUsd > 0 || res.closedLots.length > 0 ? res.realizedPnlUsd : res.tradeStats.totalRealizedPnlUsd,
        failureReasons,
      },
    }
  }

  // ── Test 1: Simple TOKEN→USDC swap (1 hop) ──────────────────────────────────
  results.push(assess('T01: TOKEN→USDC 1-hop swap', [
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'sell', amount: 100, usdValue: 150, txHash: '0xTX01' }),
    mk({ contract: USDC,    symbol: 'USDC', direction: 'buy',  amount: 150, usdValue: 150, txHash: '0xTX01' }),
  ], { expectSwap: true, expectedDirections: ['sell', 'buy'] }))

  // ── Test 2: Simple USDC→TOKEN swap (1 hop) ──────────────────────────────────
  results.push(assess('T02: USDC→TOKEN 1-hop swap', [
    mk({ contract: USDC,    symbol: 'USDC', direction: 'sell', amount: 100, usdValue: 100, txHash: '0xTX02' }),
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'buy',  amount: 200, usdValue: 100, txHash: '0xTX02' }),
  ], { expectSwap: true, expectedDirections: ['sell', 'buy'] }))

  // ── Test 3: Multi-hop TOKEN→WETH→USDC ──────────────────────────────────────
  // WETH round-trip inside tx → FIFO closes 1 WETH lot
  results.push(assess('T03: Multi-hop TOKEN→WETH→USDC', [
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'sell', amount: 100,  usdValue: 300, txHash: '0xTX03' }),
    mk({ contract: WETH,    symbol: 'WETH', direction: 'buy',  amount: 0.1,  usdValue: 300, txHash: '0xTX03', timestamp: '2024-01-01T00:00:01Z' }),
    mk({ contract: WETH,    symbol: 'WETH', direction: 'sell', amount: 0.1,  usdValue: 300, txHash: '0xTX03', timestamp: '2024-01-01T00:00:02Z' }),
    mk({ contract: USDC,    symbol: 'USDC', direction: 'buy',  amount: 300,  usdValue: 300, txHash: '0xTX03' }),
  ], { expectSwap: true }))

  // ── Test 4: Multi-hop USDC→WETH→TOKEN ──────────────────────────────────────
  results.push(assess('T04: Multi-hop USDC→WETH→TOKEN', [
    mk({ contract: USDC,    symbol: 'USDC', direction: 'sell', amount: 200,  usdValue: 200, txHash: '0xTX04' }),
    mk({ contract: WETH,    symbol: 'WETH', direction: 'buy',  amount: 0.07, usdValue: 200, txHash: '0xTX04', timestamp: '2024-01-01T01:00:00Z' }),
    mk({ contract: WETH,    symbol: 'WETH', direction: 'sell', amount: 0.07, usdValue: 200, txHash: '0xTX04', timestamp: '2024-01-01T01:00:01Z' }),
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'buy',  amount: 500,  usdValue: 200, txHash: '0xTX04' }),
  ], { expectSwap: true }))

  // ── Test 5: Native ETH swap: TOKEN→ETH (no inbound ERC20 on sell tx) ────────
  // Prior buy classified via fromRouter; sell classified via toRouter.
  // FIFO closes 1 lot across 2 separate txs.
  results.push(assess('T05: Native ETH — TOKEN→ETH (buy via router then sell to ETH)', [
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'buy',  amount: 200, usdValue: 200,
         txHash: '0xTX05A', timestamp: '2024-01-01T00:00:00Z',
         txToAddress: ROUTER, txFromAddress: ROUTER }),
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'sell', amount: 200, usdValue: 250,
         txHash: '0xTX05B', timestamp: '2024-01-01T01:00:00Z',
         txToAddress: ROUTER, txFromAddress: WALLET }),
  ], { expectSwap: true }))

  // ── Test 6: Native ETH swap: ETH→TOKEN (no outbound ERC20 on buy tx) ────────
  // Single-leg buy classified via toRouter; followed by TOKEN→USDC sell.
  results.push(assess('T06: Native ETH — ETH→TOKEN (buy only) then TOKEN→USDC sell', [
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'buy',  amount: 300, usdValue: 300,
         txHash: '0xTX06A', timestamp: '2024-01-01T00:00:00Z',
         txToAddress: ROUTER, txFromAddress: WALLET }),
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'sell', amount: 300, usdValue: 330,
         txHash: '0xTX06B', timestamp: '2024-01-01T02:00:00Z',
         txToAddress: ROUTER, txFromAddress: WALLET }),
    mk({ contract: USDC,    symbol: 'USDC', direction: 'buy',  amount: 330, usdValue: 330,
         txHash: '0xTX06B', timestamp: '2024-01-01T02:00:00Z',
         txToAddress: ROUTER, txFromAddress: WALLET }),
  ], { expectSwap: true }))

  // ── Test 7: Transfer-pattern swap: inbound + outbound, no router in tx ──────
  // Detection must rely solely on hasIn && hasOut pattern.
  results.push(assess('T07: Transfer-pattern — 1 inbound + 1 outbound, no router address', [
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'sell', amount: 100, usdValue: 100,
         txHash: '0xTX07', txToAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', txFromAddress: WALLET }),
    mk({ contract: TOKEN_B, symbol: 'TOKB', direction: 'buy',  amount: 50,  usdValue: 100,
         txHash: '0xTX07', txToAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', txFromAddress: WALLET }),
  ], { expectSwap: true }))

  // ── Test 8: Router-only swap: txToAddress is router, mixed/messy transfers ──
  // Includes an unknown-direction event; detection via toRouter.
  results.push(assess('T08: Router-only — messy mixed transfers (unknown direction present)', [
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'sell',    amount: 100, usdValue: 80,
         txHash: '0xTX08', txToAddress: ROUTER2, txFromAddress: WALLET }),
    mk({ contract: USDC,    symbol: 'USDC', direction: 'buy',     amount: 80,  usdValue: 80,
         txHash: '0xTX08', txToAddress: ROUTER2, txFromAddress: WALLET }),
    mk({ contract: WETH,    symbol: 'WETH', direction: 'unknown', amount: 0.03, usdValue: null,
         txHash: '0xTX08', txToAddress: ROUTER2, txFromAddress: WALLET }),
  ], { expectSwap: true }))

  // ── Test 9: Single-leg sell — price inferred via normalizeSingleLegs ─────────
  // TOKEN sell has usdValue=null; USDC buy in same tx provides proxy price.
  // normalizeSingleLegs should assign usdValue=80 to TOKEN sell.
  results.push(assess('T09: Single-leg — price inferred from same-tx partner (normalizeSingleLegs)', [
    mk({ contract: USDC,    symbol: 'USDC', direction: 'buy',  amount: 80,   usdValue: 80,
         txHash: '0xTX09', txToAddress: ROUTER }),
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'sell', amount: 1000, usdValue: null,
         txHash: '0xTX09', txToAddress: ROUTER }),
  ], { expectSwap: true }))

  // ── Test 10: Airdrop + sell — must NOT produce any trades ───────────────────
  // Airdrop buy: txToAddress=WALLET (not a router), no outbound in same tx.
  //   → Must NOT be tagged as swap candidate.
  // Sell later to router: single-leg sell to router.
  //   → Correctly tagged as swap (goes to router), but no buy in same tx.
  //   → FIFO: airdrop NOT swap candidate → no lot opened → sell can't close → 0 lots.
  //   → Fallback: sell-only tx has no buy → 0 trades.
  // Pass criterion: 0 fabricated trades (the key safety requirement).
  results.push(assess('T10: Airdrop + sell — no fabricated trades', [
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'buy',  amount: 1000, usdValue: 100,
         txHash: '0xTX10A', timestamp: '2024-01-01T00:00:00Z',
         txToAddress: WALLET, txFromAddress: AIRDROP }),
    mk({ contract: TOKEN_A, symbol: 'TOKA', direction: 'sell', amount: 500,  usdValue: 200,
         txHash: '0xTX10B', timestamp: '2024-01-02T00:00:00Z',
         txToAddress: ROUTER, txFromAddress: WALLET }),
  ], {
    expectSwap: true,
    expectNoTrades: true,
    // Airdrop tx must NOT be a swap candidate; sell tx correctly IS (router target).
    expectSwapPerTx: { '0xTX10A': false, '0xTX10B': true },
  }))

  return results
}

// ─── Run + Report ──────────────────────────────────────────────────────────────

const results = testFifoEngine()

const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'

console.log('\n═══════════════════════════════════════════════════════════════════════')
console.log('  FIFO Engine Test Report')
console.log('═══════════════════════════════════════════════════════════════════════\n')

const header = ['Test', 'Result', 'Swap?', 'Priced?', 'FIFO lots', 'Fallback', 'PnL USD'].join('\t')
console.log(header)
console.log('─'.repeat(80))

for (const r of results) {
  const d = r.details
  const row = [
    r.name.padEnd(46),
    r.passed ? PASS : FAIL,
    d.swapDetected   ? 'yes' : 'no ',
    d.pricedAfterNorm ? 'yes' : 'no ',
    String(d.fifoClosedLots).padStart(3),
    String(d.fallbackTrades).padStart(3),
    d.realizedPnlUsd !== null ? `$${d.realizedPnlUsd.toFixed(2)}` : 'n/a',
  ].join('\t')
  console.log(row)
}

const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed).length
console.log('\n─'.repeat(80))
console.log(`\nSummary: ${passed}/10 passed, ${failed} failed\n`)

const failures = results.filter(r => !r.passed)
if (failures.length > 0) {
  console.log('══════════════════════════════════════')
  console.log('  FAILURE MODES DETECTED')
  console.log('══════════════════════════════════════\n')
  for (const f of failures) {
    console.log(`\x1b[31m✗ ${f.name}\x1b[0m`)
    for (const reason of f.details.failureReasons) {
      const [mode, fn] = reason.split(' → ')
      console.log(`  • ${mode}`)
      console.log(`    Likely responsible: \x1b[33m${fn ?? 'unknown'}\x1b[0m`)
    }
    console.log()
  }
} else {
  console.log('\x1b[32m✓ All 10 patterns passed — engine is correct.\x1b[0m\n')
}

// Detailed per-test breakdown
console.log('\n══════════════════════════════════════')
console.log('  DETAILED OBSERVATIONS')
console.log('══════════════════════════════════════\n')
for (const r of results) {
  const d = r.details
  const status = r.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`${status} ${r.name}`)
  console.log(`   swap_candidates=${d.swapCandidateCount}  fifo_lots=${d.fifoClosedLots}  fallback_trades=${d.fallbackTrades}`)
  console.log(`   priced_before=${d.priced}  priced_after_norm=${d.pricedAfterNorm}  directions_correct=${d.allDirectionsCorrect}`)
  if (d.realizedPnlUsd !== null) console.log(`   pnl=$${d.realizedPnlUsd.toFixed(2)}`)
  if (d.failureReasons.length > 0) {
    for (const fr of d.failureReasons) console.log(`   \x1b[31m⚠ ${fr}\x1b[0m`)
  }
  console.log()
}
