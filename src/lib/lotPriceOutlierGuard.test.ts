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
