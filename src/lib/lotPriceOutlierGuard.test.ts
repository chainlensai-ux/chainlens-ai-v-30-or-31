// An impossible per-trade price (production: $24 USDC paired with a 0.00004-token dust leg ->
// $603,963/token -> $236B realized PnL) is demoted out of the verified sample; normal lots are not.
//   npx tsx --test src/lib/lotPriceOutlierGuard.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { demotePriceOutlierLots } from '@/src/lib/lotPriceOutlierGuard'
import type { MatchedLot } from '@/src/modules/fifoEngine/types'

const TOKEN = '0x226a2fa2556c48245e57cd1cba4c6c9e67077dd2'
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
    const moon = [lot({ amount: 1e6, entryPerUnit: 0.0001, exitPerUnit: 0.005 }), lot({ amount: 1e6, entryPerUnit: 0.0002, exitPerUnit: 0.004 }), lot({ amount: 1e6, entryPerUnit: 0.001, exitPerUnit: 0.003 })]
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

describe('price outlier guard on the FIFO event lookup', async () => {
  const { guardPriceUsdLookup, negligibleUnpricedLotIndexes } = await import('@/src/lib/lotPriceOutlierGuard')
  const ev = (txHash: string, amount: number, direction: 'inbound' | 'outbound' = 'inbound') => ({
    provider: 'alchemy', chain: 'base', txHash, timestamp: '2026-10-17T00:00:00.000Z', fromAddress: '0xa', toAddress: '0xb',
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
    const meme = [ev('0xm1', 100), ev('0xm2', 100), ev('0xm3', 100), ev('0xm4', 100)]
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
})
