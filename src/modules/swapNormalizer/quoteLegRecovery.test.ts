import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeQuoteAssetTransfers, recoverMissingQuoteLeg, isKnownQuoteAssetAddress, identifyRecoveryCandidate, type RawReceiptLog } from './quoteLegRecovery'

const WALLET = '0xWaLLeT0000000000000000000000000000000001'.toLowerCase()
const OTHER = '0xrouter00000000000000000000000000000000f'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const MEMECOIN = '0xmemecoin00000000000000000000000000000001'

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function pad(addr: string): string {
  return `0x${'0'.repeat(24)}${addr.replace(/^0x/, '').toLowerCase()}`
}

function transferLog(opts: { logIndex: number; address: string; from: string; to: string; amount: bigint }): RawReceiptLog {
  return {
    logIndex: opts.logIndex,
    address: opts.address,
    topics: [TRANSFER_TOPIC0, pad(opts.from), pad(opts.to)],
    data: `0x${opts.amount.toString(16)}`,
  }
}

test('isKnownQuoteAssetAddress recognizes WETH/USDC on base, case-insensitively', () => {
  assert.ok(isKnownQuoteAssetAddress('base', WETH_BASE))
  assert.ok(isKnownQuoteAssetAddress('base', WETH_BASE.toUpperCase()))
  assert.equal(isKnownQuoteAssetAddress('base', WETH_BASE)?.kind, 'native_wrapped')
  assert.equal(isKnownQuoteAssetAddress('base', USDC_BASE)?.kind, 'stable')
  assert.equal(isKnownQuoteAssetAddress('base', MEMECOIN), null)
})

test('decodeQuoteAssetTransfers finds a WETH/native quote leg recovered from a Transfer log', () => {
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 1, address: MEMECOIN, from: WALLET, to: OTHER, amount: BigInt(1000) }),
    transferLog({ logIndex: 2, address: WETH_BASE, from: OTHER, to: WALLET, amount: BigInt(500000000000000) }),
  ]
  const found = decodeQuoteAssetTransfers(logs, WALLET, 'base')
  assert.equal(found.length, 1)
  assert.equal(found[0].symbol, 'WETH')
  assert.equal(found[0].direction, 'in')
  assert.equal(found[0].amountRaw, '500000000000000')
})

test('decodeQuoteAssetTransfers finds a stable quote leg recovered from a Transfer log', () => {
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 1, address: USDC_BASE, from: WALLET, to: OTHER, amount: BigInt(100000000) }),
  ]
  const found = decodeQuoteAssetTransfers(logs, WALLET, 'base')
  assert.equal(found.length, 1)
  assert.equal(found[0].symbol, 'USDC')
  assert.equal(found[0].kind, 'stable')
  assert.equal(found[0].direction, 'out')
})

test('decodeQuoteAssetTransfers ignores non-Transfer logs and non-quote-asset tokens', () => {
  const logs: RawReceiptLog[] = [
    { logIndex: 1, address: MEMECOIN, topics: ['0xdeadbeef', pad(WALLET), pad(OTHER)], data: '0x1' },
    transferLog({ logIndex: 2, address: MEMECOIN, from: WALLET, to: OTHER, amount: BigInt(1) }),
  ]
  const found = decodeQuoteAssetTransfers(logs, WALLET, 'base')
  assert.equal(found.length, 0)
})

test('decodeQuoteAssetTransfers ignores a quote-asset transfer that does not touch the wallet', () => {
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 1, address: WETH_BASE, from: OTHER, to: '0xsomeoneelse000000000000000000000000000', amount: BigInt(1) }),
  ]
  const found = decodeQuoteAssetTransfers(logs, WALLET, 'base')
  assert.equal(found.length, 0)
})

test('recoverMissingQuoteLeg recovers the incoming WETH leg for a one-leg SELL (missingSide=tokenOut)', () => {
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 1, address: MEMECOIN, from: WALLET, to: OTHER, amount: BigInt(1000) }),
    transferLog({ logIndex: 2, address: WETH_BASE, from: OTHER, to: WALLET, amount: BigInt(500000000000000) }),
  ]
  const result = recoverMissingQuoteLeg(logs, WALLET, 'base', 'tokenOut')
  assert.equal(result.status, 'recovered')
  if (result.status === 'recovered') {
    assert.equal(result.leg.symbol, 'WETH')
    assert.equal(result.leg.direction, 'in')
  }
})

test('recoverMissingQuoteLeg recovers the outgoing stable leg for a one-leg BUY (missingSide=tokenIn)', () => {
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 1, address: USDC_BASE, from: WALLET, to: OTHER, amount: BigInt(100000000) }),
    transferLog({ logIndex: 2, address: MEMECOIN, from: OTHER, to: WALLET, amount: BigInt(5000) }),
  ]
  const result = recoverMissingQuoteLeg(logs, WALLET, 'base', 'tokenIn')
  assert.equal(result.status, 'recovered')
  if (result.status === 'recovered') {
    assert.equal(result.leg.symbol, 'USDC')
    assert.equal(result.leg.direction, 'out')
  }
})

test('recoverMissingQuoteLeg reports no_quote_transfer_in_receipt when the receipt has a wallet-facing Transfer log, just not for a recognized quote asset', () => {
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 1, address: MEMECOIN, from: WALLET, to: OTHER, amount: BigInt(1000) }),
  ]
  const result = recoverMissingQuoteLeg(logs, WALLET, 'base', 'tokenOut')
  assert.equal(result.status, 'no_quote_transfer_in_receipt')
})

test('recoverMissingQuoteLeg reports native_trace_unavailable when the receipt has NO wallet-facing Transfer log at all (Wallet Scanner audit, Item 6 — raw native-ETH settlement, honestly out of scope without a trace API)', () => {
  const logs: RawReceiptLog[] = []
  const result = recoverMissingQuoteLeg(logs, WALLET, 'base', 'tokenOut')
  assert.equal(result.status, 'native_trace_unavailable')
})

test('recoverMissingQuoteLeg reports native_trace_unavailable when the receipt only has Transfer logs for OTHER wallets, never the scanned wallet', () => {
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 1, address: MEMECOIN, from: OTHER, to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead', amount: BigInt(1000) }),
  ]
  const result = recoverMissingQuoteLeg(logs, WALLET, 'base', 'tokenOut')
  assert.equal(result.status, 'native_trace_unavailable')
})

test('recoverMissingQuoteLeg reports wrong_direction_only rather than fabricating a match when only the wrong-direction leg exists', () => {
  // Missing side is tokenOut (need an INCOMING quote leg), but the only quote-asset transfer in the
  // receipt is OUTGOING (e.g. a fee payment unrelated to the actual swap proceeds) — never guessed.
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 1, address: WETH_BASE, from: WALLET, to: OTHER, amount: BigInt(1) }),
  ]
  const result = recoverMissingQuoteLeg(logs, WALLET, 'base', 'tokenOut')
  assert.equal(result.status, 'wrong_direction_only')
})

test('recoverMissingQuoteLeg picks the highest logIndex when multiple matching legs exist (final settlement leg)', () => {
  const logs: RawReceiptLog[] = [
    transferLog({ logIndex: 2, address: WETH_BASE, from: OTHER, to: WALLET, amount: BigInt(100) }),
    transferLog({ logIndex: 5, address: USDC_BASE, from: OTHER, to: WALLET, amount: BigInt(200) }),
  ]
  const result = recoverMissingQuoteLeg(logs, WALLET, 'base', 'tokenOut')
  assert.equal(result.status, 'recovered')
  if (result.status === 'recovered') assert.equal(result.leg.logIndex, 5)
})

test('identifyRecoveryCandidate: a sell with only the outgoing memecoin leg is a candidate needing tokenOut recovery', () => {
  const result = identifyRecoveryCandidate([{ contract: MEMECOIN, from: WALLET, to: OTHER }], WALLET, 'base')
  assert.deepEqual(result, { candidate: true, missingSide: 'tokenOut', knownContract: MEMECOIN })
})

test('identifyRecoveryCandidate: a buy with only the incoming memecoin leg is a candidate needing tokenIn recovery', () => {
  const result = identifyRecoveryCandidate([{ contract: MEMECOIN, from: OTHER, to: WALLET }], WALLET, 'base')
  assert.deepEqual(result, { candidate: true, missingSide: 'tokenIn', knownContract: MEMECOIN })
})

test('identifyRecoveryCandidate: both legs already present is never a candidate (nothing to recover)', () => {
  const result = identifyRecoveryCandidate([
    { contract: MEMECOIN, from: WALLET, to: OTHER },
    { contract: WETH_BASE, from: OTHER, to: WALLET },
  ], WALLET, 'base')
  assert.equal(result.candidate, false)
  if (!result.candidate) assert.equal(result.reason, 'both_legs_present')
})

test('identifyRecoveryCandidate: no wallet-facing transfer at all is never a candidate', () => {
  const result = identifyRecoveryCandidate([{ contract: MEMECOIN, from: OTHER, to: '0xsomeoneelse000000000000000000000000000' }], WALLET, 'base')
  assert.equal(result.candidate, false)
  if (!result.candidate) assert.equal(result.reason, 'no_wallet_facing_transfer')
})

test('identifyRecoveryCandidate: the known leg already being a quote asset is never a candidate (different, out-of-scope recovery problem)', () => {
  const result = identifyRecoveryCandidate([{ contract: WETH_BASE, from: WALLET, to: OTHER }], WALLET, 'base')
  assert.equal(result.candidate, false)
  if (!result.candidate) assert.equal(result.reason, 'known_leg_already_quote_asset')
})
