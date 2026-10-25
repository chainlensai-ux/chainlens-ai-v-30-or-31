import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCompleteWalletScanResult, prescanCandidates, walletScanLatestKey } from './walletScanLatest'

test('only a complete result can stand as the latest scan', () => {
  assert.equal(isCompleteWalletScanResult({ success: true, data: {} }), true)
  assert.equal(isCompleteWalletScanResult({ success: false }), false)
  assert.equal(isCompleteWalletScanResult({ success: true, partial: true }), false, 'timed-out partial result')
  assert.equal(isCompleteWalletScanResult({ success: true, pnlStillProcessing: true, pnlFollowUpJobId: 'f1' }), false, 'PnL deferred to a follow-up job')
  assert.equal(isCompleteWalletScanResult({ success: true, data: { pnlFollowUpJobId: 'f1' } }), false)
  assert.equal(isCompleteWalletScanResult(null), false)
})

test('pre-scan candidates: one per user and wallet, valid addresses only, order kept', () => {
  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)
  const rows = [
    { user_id: 'u1', address: A.toUpperCase().replace('0X', '0x') },
    { user_id: 'u1', address: A },
    { user_id: 'u2', address: A },
    { user_id: 'u1', address: 'not-an-address' },
    { user_id: '', address: B },
    { user_id: 'u1', address: B },
  ]
  assert.deepEqual(prescanCandidates(rows), [{ userId: 'u1', wallet: A }, { userId: 'u2', wallet: A }, { userId: 'u1', wallet: B }])
})

test('the latest-scan key is per user, wallet (case-insensitive) and mode', () => {
  assert.equal(walletScanLatestKey('u1', '0xABC', 'normal'), 'walletScanLatest:v1:u1:0xabc:normal')
  assert.notEqual(walletScanLatestKey('u1', '0xabc', 'normal'), walletScanLatestKey('u2', '0xabc', 'normal'))
})
