// [robinhood-historical-acquisition-funding-audit] (diagnostic only): did the WALLET fund the route that produced an
// acquisition candidate's target token? Token receipt alone is never ownership; a native debit somewhere is never
// funding by itself — the unchanged analyzer must connect a wallet-funded asset to the target with the complete trace.
// Shapes: 0x0dbd7fea…7312 / 0xc2641e5f…7b7e (historical PRIORS candidates for the 0x0d1ec4 sell).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { robinhoodAcquisitionFundingAudit } from '../lib/server/robinhoodAcquisitionFundingAudit.ts'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0, WETH_DEPOSIT_TOPIC0, type RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'
import { RH_WETH, type RhPoolKey, type RhReceipt } from '../lib/server/robinhoodPnlV1.ts'

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x3333333333333333333333333333333333333333'
const NATIVE = '0x0000000000000000000000000000000000000000'
const C = '0xcccc000000000000000000000000000000000003'
const SWAP4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MODIFY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(x) * E18

const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))

function poolKey(x: string, y: string) {
  const [c0, c1] = [x, y].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, NATIVE as Hex] as const
  return { id: keccak256(encodeAbiParameters(types, args)).toLowerCase(), c0, c1, encoded: encodeAbiParameters(types, args) }
}

class Rx {
  logs: RhReceipt['logs'] = []
  keys = new Map<string, RhPoolKey>()
  encoded = new Map<string, string>()
  private i = 0
  private push(l: Omit<RhReceipt['logs'][number], 'logIndex' | 'blockTimestamp'>) { this.logs.push({ ...l, logIndex: this.i++, blockTimestamp: 1_760_000_000 }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push({ address: token, topics: [TRANSFER, t(from), t(to)], data: `0x${uint(amt)}` }) }
  /** V4: swapper perspective — `inTok` paid in (negative), `outTok` taken out (positive). */
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint) {
    const k = poolKey(inTok, outTok)
    this.keys.set(k.id, { currency0: k.c0, currency1: k.c1 })
    this.encoded.set(k.id, k.encoded)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push({ address: PM, topics: [SWAP4, k.id, t(ROUTER)], data: `0x${int256(d[k.c0])}${int256(d[k.c1])}${'0'.repeat(256)}` })
  }
  /** V3: pool perspective — in positive, out negative (token0/token1 order irrelevant to the analyzer). */
  v3(pool: string, inAmt: bigint, outAmt: bigint) { return this.push({ address: pool, topics: [V3_SWAP_TOPIC0, t(ROUTER), t(ROUTER)], data: `0x${int256(inAmt)}${int256(-outAmt)}${'0'.repeat(192)}` }) }
  v2(pool: string, inAmt: bigint, outAmt: bigint) { return this.push({ address: pool, topics: [V2_SWAP_TOPIC0, t(ROUTER), t(ROUTER)], data: `0x${uint(inAmt)}${uint(BigInt(0))}${uint(BigInt(0))}${uint(outAmt)}` }) }
  unwrap(holder: string, amt: bigint) { return this.push({ address: RH_WETH, topics: [WETH_WITHDRAWAL_TOPIC0, t(holder)], data: `0x${uint(amt)}` }) }
  wrap(holder: string, amt: bigint) { return this.push({ address: RH_WETH, topics: [WETH_DEPOSIT_TOPIC0, t(holder)], data: `0x${uint(amt)}` }) }
  liquidity() { return this.push({ address: PM, topics: [MODIFY, t(ROUTER)], data: '0x' }) }
  receipt(from = WALLET): RhReceipt { return { status: 1, from, to: ROUTER, blockNumber: 500, gasUsed: BigInt(100_000), effectiveGasPrice: BigInt(1_000_000_000), logs: this.logs } }
}

const RELAYER = '0x7777777777777777777777777777777777777777'
const USER2 = '0x9999999999999999999999999999999999999999'
const PRIORS = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5'
const nt = (from: string, to: string, value: bigint): RhNativeTransfer => ({ from, to, value, success: true })
const audit = (rx: Rx, trace: RhNativeTransfer[] | null, txValue: bigint | null = BigInt(0), from = RELAYER) =>
  robinhoodAcquisitionFundingAudit({ wallet: WALLET, txHash: '0x0dbd', receipt: rx.receipt(from), targetToken: PRIORS, poolManager: PM, wethAddress: RH_WETH, v4PoolKeys: rx.keys, trace, txValue })

test('0x0dbd shape: externally funded batch — executor prefunded by another address, wallet only receives PRIORS → not proven, not promotable', () => {
  const rx = new Rx().v4(NATIVE, PRIORS, n(2), n(5000)).xfer(PRIORS, PM, ROUTER, n(5000)).xfer(PRIORS, ROUTER, WALLET, n(5000))
  const a = audit(rx, [nt(USER2, ROUTER, n(2)), nt(ROUTER, PM, n(2))])
  assert.deepEqual([a.walletFundingAssets, a.directWalletDebits.length, a.targetTokenCreditRaw], [[], 0, n(5000).toString()])
  assert.ok(a.executorFundingSources.some((s) => s.from === USER2))
  assert.ok(a.competingFundingSources.some((s) => s.from === USER2))
  assert.equal(a.fundingToOutputPathProven, false)
  assert.match(a.fundingPathReason, /^no_wallet_funding_asset/)
  assert.equal(a.safePromotionPossible, false)
})

test('wallet-funded relayed buy: traced wallet native → executor → PoolManager → PRIORS to the wallet → proven, promotable under existing semantics', () => {
  const rx = new Rx().v4(NATIVE, PRIORS, n(2), n(5000)).xfer(PRIORS, PM, WALLET, n(5000))
  const a = audit(rx, [nt(WALLET, ROUTER, n(2)), nt(ROUTER, PM, n(2))])
  assert.deepEqual(a.walletFundingRawByAsset, { native: n(2).toString() })
  assert.deepEqual([a.competingFundingSources, a.connectedSwapActions], [[], [0]])
  assert.equal(a.fundingToOutputPathProven, true, a.fundingPathReason)
  assert.equal(a.safePromotionPossible, true)
})

test('wallet native debit exists but another address co-funds the route → competing payer, not proven', () => {
  const rx = new Rx().v4(NATIVE, PRIORS, n(2), n(5000)).xfer(PRIORS, PM, WALLET, n(5000))
  const a = audit(rx, [nt(WALLET, ROUTER, n(1)), nt(USER2, ROUTER, n(1)), nt(ROUTER, PM, n(2))])
  assert.equal(a.fundingToOutputPathProven, false)
  assert.match(a.fundingPathReason, /^competing_native_payers:/)
})

test('wallet ERC-20 debit of an unrelated asset never funds an externally produced PRIORS output', () => {
  const rx = new Rx().xfer(C, WALLET, USER2, n(7)).v4(NATIVE, PRIORS, n(2), n(5000)).xfer(PRIORS, PM, WALLET, n(5000))
  const a = audit(rx, [nt(USER2, ROUTER, n(2)), nt(ROUTER, PM, n(2))])
  assert.deepEqual(a.walletFundingAssets, [C])
  assert.equal(a.fundingToOutputPathProven, false)
})

test('a full refund nets the wallet funding to zero', () => {
  const rx = new Rx().v4(NATIVE, PRIORS, n(2), n(5000)).xfer(PRIORS, PM, WALLET, n(5000))
  const a = audit(rx, [nt(WALLET, ROUTER, n(2)), nt(ROUTER, WALLET, n(2)), nt(USER2, PM, n(2))])
  assert.deepEqual(a.walletFundingAssets, [])
  assert.equal(a.refundFlows.length, 1)
  assert.equal(a.fundingToOutputPathProven, false)
})

test('no complete native trace → never proven', () => {
  const rx = new Rx().v4(NATIVE, PRIORS, n(2), n(5000)).xfer(PRIORS, PM, WALLET, n(5000))
  const a = audit(rx, null)
  assert.deepEqual([a.traceComplete, a.fundingToOutputPathProven, a.fundingPathReason], [false, false, 'no_complete_native_trace'])
})

test('relayed tx with unknown top-level value: path may be proven but promotion is not (value never assumed zero)', () => {
  const rx = new Rx().v4(NATIVE, PRIORS, n(2), n(5000)).xfer(PRIORS, PM, WALLET, n(5000))
  const a = audit(rx, [nt(WALLET, ROUTER, n(2)), nt(ROUTER, PM, n(2))], null)
  assert.equal(a.safePromotionPossible, false)
})
