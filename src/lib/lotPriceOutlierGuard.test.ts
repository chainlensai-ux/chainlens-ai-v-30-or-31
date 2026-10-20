// An impossible per-trade price (production: $24 USDC paired with a 0.00004-token dust leg ->
// $603,963/token -> $236B realized PnL) is demoted out of the verified sample; normal lots are not.
//   npx tsx --test src/lib/lotPriceOutlierGuard.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { demotePriceOutlierLots } from '@/src/lib/lotPriceOutlierGuard'
import type { MatchedLot } from '@/src/modules/fifoEngine/types'

const TOKEN = '0x226a2fa2556c48245e57cd1cba4c6c9e67077dd2'
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
let seq = 0
function lot(over: Partial<MatchedLot> & { entryPerUnit: number; exitPerUnit: number; amount: number }): MatchedLot {
  seq += 1
  const { entryPerUnit, exitPerUnit, ...rest } = over
  const costBasisUsd = entryPerUnit * over.amount
  const proceedsUsd = exitPerUnit * over.amount
  return {
    lotId: `lot-${seq}`, token: TOKEN, chain: 'base', openedAt: 1_000 + seq, closedAt: 2_000 + seq,
    openedTxHash: `0xopen${seq}`, closedTxHash: `0xclose${seq}`,
    costBasisUsd, proceedsUsd, realizedPnlUsd: proceedsUsd - costBasisUsd, evidenceQuality: 'verified', ...rest,
  }
}

describe('lot price outlier guard', () => {
  it('demotes a dust-derived $603,963/token entry and leaves the token’s normal trades verified', () => {
    const normal = [lot({ amount: 2_000, entryPerUnit: 0.012, exitPerUnit: 0.013 }), lot({ amount: 1_500, entryPerUnit: 0.011, exitPerUnit: 0.012 }), lot({ amount: 900, entryPerUnit: 0.014, exitPerUnit: 0.012 })]
    const bad = lot({ amount: 2_181.125923374, entryPerUnit: 603_963.5501570264, exitPerUnit: 0.012 })
    const result = demotePriceOutlierLots([...normal, bad])
    assert.equal(result.demotedLotCount, 1)
    assert.equal(result.lots[3].evidenceQuality, 'unpriced')
    assert.ok(result.lots.slice(0, 3).every((l) => l.evidenceQuality === 'verified'))
    assert.equal(result.outliers[0].side, 'entry')
    assert.equal(result.outliers[0].reason, 'token_price_outlier')
    const realized = result.lots.filter((l) => l.evidenceQuality === 'verified').reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0)
    assert.ok(Math.abs(realized) < 10, `realized stays sane: ${realized}`)
  })

  it('catches a huge side on a thinly traded token via the wallet-wide value check', () => {
    const others = Array.from({ length: 20 }, (_, i) => lot({ token: `0xother${i}`, amount: 100, entryPerUnit: 0.5, exitPerUnit: 0.6 }))
    const lone = lot({ token: '0xb200000000000000000000cfbdf64a8706a94a01', amount: 5_000, entryPerUnit: 0.01, exitPerUnit: 403_315 })
    const result = demotePriceOutlierLots([...others, lone])
    assert.equal(result.demotedLotCount, 1)
    assert.equal(result.outliers[0].reason, 'wallet_value_outlier')
    assert.equal(result.lots[20].evidenceQuality, 'unpriced')
  })

  it('leaves a real 50x move and a genuinely large wallet alone', () => {
    const days = (n: number) => n * DAY_MS
    const moon = [
      lot({ amount: 1e6, entryPerUnit: 0.0001, exitPerUnit: 0.005, openedAt: days(0), closedAt: days(9) }),
      lot({ amount: 1e6, entryPerUnit: 0.0002, exitPerUnit: 0.004, openedAt: days(2), closedAt: days(7) }),
      lot({ amount: 1e6, entryPerUnit: 0.001, exitPerUnit: 0.003, openedAt: days(4), closedAt: days(5) }),
    ]
    assert.equal(demotePriceOutlierLots(moon).demotedLotCount, 0)
    const whale = Array.from({ length: 10 }, (_, i) => lot({ token: `0xw${i}`, amount: 1_000, entryPerUnit: 2_000, exitPerUnit: 2_100 }))
    assert.equal(demotePriceOutlierLots(whale).demotedLotCount, 0)
  })

  it('treats partial fills of one side as one sample, and ignores unpriced lots', () => {
    const shared = { openedTxHash: '0xsameopen' }
    const lots = [
      lot({ ...shared, amount: 10, entryPerUnit: 1, exitPerUnit: 1.1 }),
      lot({ ...shared, amount: 20, entryPerUnit: 1, exitPerUnit: 1.2 }),
      lot({ amount: 5, entryPerUnit: 1.05, exitPerUnit: 1 }),
      { ...lot({ amount: 5, entryPerUnit: 9e9, exitPerUnit: 1 }), evidenceQuality: 'unpriced' as const },
    ]
    assert.equal(demotePriceOutlierLots(lots).demotedLotCount, 0)
  })
})

describe('local price outlier guard', () => {
  const CHIP = '0x0c1c1c109fe34733fca54b82d7b46b75cfb71f6e'
  const at = (minutes: number) => 1_792_346_273_000 + minutes * MINUTE_MS

  it('demotes a CHIP sell at $0.0064 between same-hour trades at ~$0.04 (production: -$1,376.77)', () => {
    const neighbours = [
      lot({ token: CHIP, amount: 5_000, entryPerUnit: 0.041, exitPerUnit: 0.040, openedAt: at(0), closedAt: at(2) }),
      lot({ token: CHIP, amount: 5_000, entryPerUnit: 0.040, exitPerUnit: 0.039, openedAt: at(4), closedAt: at(40) }),
      lot({ token: CHIP, amount: 3_000, entryPerUnit: 0.0405, exitPerUnit: 0.0395, openedAt: at(43), closedAt: at(55) }),
    ]
    const bad = lot({ token: CHIP, amount: 40_033.620080174, entryPerUnit: 0.04077, exitPerUnit: 0.00638, openedAt: at(42), closedAt: at(54) })
    const result = demotePriceOutlierLots([...neighbours, bad])
    assert.deepEqual(result.lots.map((l) => l.evidenceQuality), ['verified', 'verified', 'verified', 'unpriced'])
    assert.equal(result.outliers.length, 1)
    assert.equal(result.outliers[0].reason, 'token_local_price_outlier')
    assert.equal(result.outliers[0].side, 'exit')
  })

  it('demotes a VIRTUAL sell ~780x under the same day\'s trades even with no other trade inside the hour', () => {
    const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'
    const hours = (n: number) => at(0) + n * 60 * MINUTE_MS
    const day = [
      lot({ token: VIRTUAL, amount: 47.8, entryPerUnit: 0.657, exitPerUnit: 0.658, openedAt: hours(0), closedAt: hours(2) }),
      lot({ token: VIRTUAL, amount: 47.7, entryPerUnit: 0.66, exitPerUnit: 0.661, openedAt: hours(4), closedAt: hours(6) }),
      lot({ token: VIRTUAL, amount: 47.9, entryPerUnit: 0.66, exitPerUnit: 0.659, openedAt: hours(12), closedAt: hours(14) }),
    ]
    const bad = lot({ token: VIRTUAL, amount: 47.63, entryPerUnit: 0.6596, exitPerUnit: 0.00085, openedAt: hours(8), closedAt: hours(9.5) })
    const result = demotePriceOutlierLots([...day, bad])
    assert.deepEqual(result.lots.map((l) => l.evidenceQuality), ['verified', 'verified', 'verified', 'unpriced'])
    assert.equal(result.outliers.length, 1)
    assert.equal(result.outliers[0].side, 'exit')
  })

  it('needs enough neighbours inside the hour; the same price gap days apart is a real move', () => {
    const spread = [
      lot({ token: CHIP, amount: 5_000, entryPerUnit: 0.041, exitPerUnit: 0.040, openedAt: at(0), closedAt: DAY_MS + at(0) }),
      lot({ token: CHIP, amount: 5_000, entryPerUnit: 0.040, exitPerUnit: 0.039, openedAt: 2 * DAY_MS + at(0), closedAt: 3 * DAY_MS + at(0) }),
      lot({ token: CHIP, amount: 3_000, entryPerUnit: 0.0405, exitPerUnit: 0.0395, openedAt: 4 * DAY_MS + at(0), closedAt: 5 * DAY_MS + at(0) }),
      lot({ token: CHIP, amount: 40_000, entryPerUnit: 0.04, exitPerUnit: 0.0064, openedAt: 6 * DAY_MS + at(0), closedAt: 9 * DAY_MS + at(0) }),
    ]
    assert.equal(demotePriceOutlierLots(spread).demotedLotCount, 0)
  })

  it('rejects the same bad sell on the FIFO event lookup', async () => {
    const { guardPriceUsdLookup } = await import('@/src/lib/lotPriceOutlierGuard')
    const ev = (txHash: string, amount: number, minutes: number) => ({
      provider: 'alchemy', chain: 'base', txHash, timestamp: new Date(at(minutes)).toISOString(), fromAddress: '0xa', toAddress: '0xb',
      contract: CHIP, symbol: 'CHIP', amount, amountRaw: null, tokenDecimals: 18, direction: 'outbound',
    }) as unknown as import('@/src/modules/normalization/types').NormalizedEvent
    const events = [ev('0x1', 5_000, 0), ev('0x2', 5_000, 10), ev('0x3', 3_000, 30), ev('0xbad', 40_033, 54)]
    const usd: Record<string, number> = { '0x1': 205, '0x2': 200, '0x3': 121, '0xbad': 255.42 }
    const guarded = guardPriceUsdLookup(events, (e) => usd[e.txHash] ?? null)
    assert.equal(guarded.lookup(events[3]), null)
    assert.equal(guarded.lookup(events[0]), 205)
    assert.equal(guarded.rejectedEvents, 1)
  })
})

describe('price outlier guard on the FIFO event lookup', async () => {
  const { guardPriceUsdLookup, negligibleUnpricedLotIndexes } = await import('@/src/lib/lotPriceOutlierGuard')
  const ev = (txHash: string, amount: number, direction: 'inbound' | 'outbound' = 'inbound', timestamp = '2026-10-17T00:00:00.000Z') => ({
    provider: 'alchemy', chain: 'base', txHash, timestamp, fromAddress: '0xa', toAddress: '0xb',
    contract: TOKEN, symbol: 'T', amount, amountRaw: null, tokenDecimals: 18, direction,
  }) as unknown as import('@/src/modules/normalization/types').NormalizedEvent

  it('reads a dust buy priced at $603,963/token as unpriced, so it can never be an open cost basis', () => {
    const usdByTx: Record<string, number> = { '0x1': 24, '0x2': 18, '0x3': 30, '0xdust': 24.046795 }
    const events = [ev('0x1', 2000), ev('0x2', 1500), ev('0x3', 2500), ev('0xdust', 0.00003981497723455)]
    const guarded = guardPriceUsdLookup(events, (e) => usdByTx[e.txHash] ?? null)
    assert.equal(guarded.rejectedEvents, 1)
    assert.equal(guarded.lookup(events[3]), null)
    assert.equal(guarded.lookup(events[0]), 24)
  })

  it('reads an astronomically valued sell as unpriced (wallet-wide check)', () => {
    const events = [...Array.from({ length: 10 }, (_, i) => ev(`0xb${i}`, 100)), ev('0xhuge', 5_701, 'outbound')]
    const guarded = guardPriceUsdLookup(events, (e) => (e.txHash === '0xhuge' ? 3.15e19 : 50))
    assert.equal(guarded.lookup(events[10]), null)
    assert.equal(guarded.rejectedEvents, 1)
  })

  it('a dust lot left unpriced does not count as a missing sibling on the sell it shares', () => {
    const shared = { closedTxHash: '0xbigsell' }
    const lots = [lot({ ...shared, amount: 3000, entryPerUnit: 0.01, exitPerUnit: 0.012 }), lot({ ...shared, amount: 2701, entryPerUnit: 0.011, exitPerUnit: 0.012 }),
      { ...lot({ ...shared, amount: 9.97e-13, entryPerUnit: 1, exitPerUnit: 0.012 }), evidenceQuality: 'unpriced' as const, costBasisUsd: null }]
    assert.deepEqual([...negligibleUnpricedLotIndexes(lots)], [2])
    const realSized = [lots[0], { ...lots[1], evidenceQuality: 'unpriced' as const }]
    assert.equal(negligibleUnpricedLotIndexes(realSized).size, 0, 'a real-sized unpriced lot still counts')
  })

  it('WETH and cbBTC sides far from the token median are rejected; a normal memecoin swing is not', () => {
    const WETH = '0x4200000000000000000000000000000000000006'
    const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'
    const mk = (txHash: string, contract: string, amount: number) => ({ ...ev(txHash, amount), contract })
    const weth = [mk('0xw1', WETH, 0.1), mk('0xw2', WETH, 0.2), mk('0xw3', WETH, 0.05), mk('0xwbad', WETH, 0.18)]
    const btc = [mk('0xb1', CBBTC, 0.001), mk('0xb2', CBBTC, 0.002), mk('0xb3', CBBTC, 0.003), mk('0xbbad', CBBTC, 0.0021)]
    const meme = ['0xm1', '0xm2', '0xm3', '0xm4'].map((tx, i) => ev(tx, 100, 'inbound', `2026-10-1${i}T00:00:00.000Z`))
    const usd: Record<string, number> = {
      '0xw1': 241, '0xw2': 480, '0xw3': 121, '0xwbad': 59.38,
      '0xb1': 81.5, '0xb2': 163, '0xb3': 245, '0xbbad': 58.43,
      '0xm1': 1, '0xm2': 1, '0xm3': 1, '0xm4': 10,
    }
    const guarded = guardPriceUsdLookup([...weth, ...btc, ...meme], (e) => usd[e.txHash] ?? null)
    assert.equal(guarded.lookup(weth[3]), null, 'WETH at $330 next to a $2.4k median')
    assert.equal(guarded.lookup(btc[3]), null, 'cbBTC at $27.8k next to an $81.5k median')
    assert.equal(guarded.lookup(weth[0]), 241)
    assert.equal(guarded.lookup(meme[3]), 10, 'a 10x memecoin move is real')
    assert.equal(guarded.rejectedEvents, 2)
  })

  it('a rejected WETH side reads amount x market price when the hour\'s price is known; others stay unpriced', () => {
    const WETH = '0x4200000000000000000000000000000000000006'
    const mk = (txHash: string, contract: string, amount: number) => ({ ...ev(txHash, amount), contract })
    const weth = [mk('0xw1', WETH, 0.1), mk('0xw2', WETH, 0.2), mk('0xw3', WETH, 0.05), mk('0xwbad', WETH, 0.18)]
    const meme = [ev('0xm1', 100), ev('0xm2', 100), ev('0xm3', 100), ev('0xmbad', 100)]
    const usd: Record<string, number> = { '0xw1': 241, '0xw2': 480, '0xw3': 121, '0xwbad': 59.38, '0xm1': 1, '0xm2': 1, '0xm3': 1, '0xmbad': 5000 }
    const guarded = guardPriceUsdLookup([...weth, ...meme], (e) => usd[e.txHash] ?? null, { majorMarketValueUsd: (e) => e.amount * 2400 })
    assert.equal(guarded.lookup(weth[3]), 0.18 * 2400)
    assert.equal(guarded.lookup(meme[3]), null)
    assert.equal(guarded.repricedMajorEvents, 1)
    assert.equal(guarded.rejectedEvents, 1)
  })
  it('demotes a lone lot with an impossible return even when the token has too few trades for a median', () => {
    // Production (scan b6519b82): cost $3.9e-14, proceeds $70.35 on this token, counted as +$70 verified.
    const bad = { ...lot({ amount: 1.67e-12, entryPerUnit: 0.0234, exitPerUnit: 4.2e13 }), costBasisUsd: 3.9e-14, proceedsUsd: 70.35, realizedPnlUsd: 70.35 }
    const result = demotePriceOutlierLots([bad])
    assert.equal(result.demotedLotCount, 1)
    assert.equal(result.outliers[0].reason, 'lot_return_outlier')
    assert.equal(result.lots[0].evidenceQuality, 'unpriced')
  })

  it('demotes a same-transaction dust leg but keeps a real same-transaction trade and a real 50x', () => {
    const dust = lot({ amount: 1e-12, entryPerUnit: 1, exitPerUnit: 1.2, openedTxHash: '0xsame', closedTxHash: '0xsame' })
    const realSameTx = lot({ amount: 100, entryPerUnit: 1, exitPerUnit: 1.01, openedTxHash: '0xsame2', closedTxHash: '0xsame2' })
    const fiftyX = lot({ token: '0xother', amount: 1_000, entryPerUnit: 0.001, exitPerUnit: 0.05 })
    const result = demotePriceOutlierLots([dust, realSameTx, fiftyX])
    assert.equal(result.demotedLotCount, 1)
    assert.equal(result.outliers[0].reason, 'same_tx_dust_lot')
    assert.deepEqual(result.lots.map((l) => l.evidenceQuality), ['unpriced', 'verified', 'verified'])
  })
})

describe('lot price outlier guard — tight same-hour band', () => {
  const STOCK = '0xb200000000000000000000c2e324d24d7eecd1fb'
  const t0 = 1_792_446_449_000

  it('demotes a buy 30% under a token whose other sides that hour all agree within 5% (production: $234.69 vs $342.7)', () => {
    const sells = [0, 5, 10, 20].map((m, i) => lot({
      token: STOCK, amount: 2.92, entryPerUnit: 341 + i * 0.2, exitPerUnit: 342.7 + i * 0.03,
      openedAt: t0 - 30 * MINUTE_MS + m * MINUTE_MS, closedAt: t0 + m * MINUTE_MS,
      openedTxHash: `0xstockbuy${i}`, closedTxHash: `0xstocksell${i}`,
    }))
    const bad = lot({ token: STOCK, amount: 1.47, entryPerUnit: 234.69, exitPerUnit: 342.71, openedAt: t0, closedAt: t0 + 36_000, openedTxHash: '0x28245e2f', closedTxHash: '0xb3b1454e' })
    const result = demotePriceOutlierLots([...sells, bad])
    assert.equal(result.demotedLotCount, 1)
    assert.equal(result.lots[4].evidenceQuality, 'unpriced')
    assert.deepEqual(result.outliers.map((o) => [o.txHash, o.side, o.reason]), [['0x28245e2f', 'entry', 'token_local_price_outlier']])
  })

  it('never applies to a volatile token whose same-hour sides already spread beyond the band', () => {
    const meme = [0.010, 0.013, 0.016, 0.0095].map((p, i) => lot({ amount: 1_000, entryPerUnit: p, exitPerUnit: p * 1.1, openedAt: t0 + i * MINUTE_MS, closedAt: t0 + (i + 1) * MINUTE_MS }))
    const pump = lot({ amount: 1_000, entryPerUnit: 0.012, exitPerUnit: 0.02, openedAt: t0 + 5 * MINUTE_MS, closedAt: t0 + 6 * MINUTE_MS })
    assert.equal(demotePriceOutlierLots([...meme, pump]).demotedLotCount, 0)
  })
})
