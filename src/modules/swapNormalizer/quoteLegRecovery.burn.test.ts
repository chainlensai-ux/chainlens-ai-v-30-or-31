// Burns (sent to the zero/dead address) and multi-token payouts are never one-leg swap candidates, so they
// cannot use up the receipt slots meant for real trades. Real shapes from the DGUY creator wallet: a
// 1,000,000 DGUY transfer to 0x…dEaD, and LP-fee payouts of DGUY + AMZNc from 0x71d1…7a7f (tx 0x003f…fc10).
//   npx tsx --test src/modules/swapNormalizer/quoteLegRecovery.burn.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identifyRecoveryCandidate } from './quoteLegRecovery'
import { rankQuoteLegRecoveryBundles } from '../../../app/api/_shared/walletChainPipeline'

const WALLET = '0x404a2e936be3c9faccb4a59c764c1d14f6add1af'
const DGUY = '0xe34356dcd3d7bb991248f322e4ec31b5d60bc54e'
const OTHER = '0x22091141a45dfa94a834fd2e14f92f08f148e9e5'
const POOL = '0x4be684f77419999aa3e1162d25d9ae6ff64c05a0'

test('a transfer to the dead or zero address is not a recovery candidate', () => {
  for (const to of ['0x000000000000000000000000000000000000dEaD', '0x0000000000000000000000000000000000000000']) {
    assert.deepEqual(identifyRecoveryCandidate([{ contract: DGUY, from: WALLET, to }], WALLET, 'base'), { candidate: false, reason: 'burn_transfer' })
  }
})

const AMZNC = '0xb200000000000000000000d9192b6b456483c2e8'
const FEE_SPLITTER = '0x71d1d363176723f85d98b8b430df33cde89f0a7f'

test('receiving two different tokens while sending nothing (a fee payout) is not a candidate', () => {
  assert.deepEqual(identifyRecoveryCandidate([{ contract: DGUY, from: FEE_SPLITTER, to: WALLET }, { contract: AMZNC, from: FEE_SPLITTER, to: WALLET }], WALLET, 'base'), { candidate: false, reason: 'multi_token_inbound' })
})

test('receiving one token while sending nothing (a buy paid in ETH) is still a candidate', () => {
  assert.deepEqual(identifyRecoveryCandidate([{ contract: DGUY, from: POOL, to: WALLET }], WALLET, 'base'), { candidate: true, missingSide: 'tokenIn', knownContract: DGUY })
})

test('a one-sided sale to a pool is still a candidate', () => {
  assert.deepEqual(identifyRecoveryCandidate([{ contract: DGUY, from: WALLET, to: POOL }], WALLET, 'base'), { candidate: true, missingSide: 'tokenOut', knownContract: DGUY })
})

test('ranking: many burns of one token no longer outrank a real one-leg trade', () => {
  const burns = Array.from({ length: 30 }, (_, i) => ({ txHash: `0xburn${String(i).padStart(2, '0')}`, transfers: [{ contract: DGUY, from: WALLET, to: '0x000000000000000000000000000000000000dead', logIndex: 0 }] }))
  const trade = { txHash: '0xtrade', transfers: [{ contract: OTHER, from: WALLET, to: POOL, logIndex: 0 }] }
  const ranked = rankQuoteLegRecoveryBundles([...burns, trade] as never, WALLET, 'base')
  assert.equal(ranked[0].txHash, '0xtrade')
})
