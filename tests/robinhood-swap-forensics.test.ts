// Robinhood swap verification forensics (lib/server/robinhoodSwapForensics.ts): A/B/C/D attribution from
// receipt evidence only. Diagnostic: PnL V1 acceptance is unchanged (a relayed swap is still rejected).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { buildRobinhoodSwapForensics } from '../lib/server/robinhoodSwapForensics.ts'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_V4_POSITION_MANAGER, type RhReceipt, type RhPoolKey, type RhRpc } from '../lib/server/robinhoodPnlV1.ts'

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const RELAYER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const ROUTER = '0x3333333333333333333333333333333333333333'
const TOKEN_A = '0xaaaa000000000000000000000000000000000001'
const TOKEN_B = '0xbbbb000000000000000000000000000000000002'
const NATIVE = '0x0000000000000000000000000000000000000000'
const SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const E18 = BigInt(10) ** BigInt(18)

const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))

function pool(x: string, y: string) {
  const [c0, c1] = [x, y].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, NATIVE as Hex] as const
  return { poolId: keccak256(encodeAbiParameters(types, args)).toLowerCase(), c0, c1, encoded: encodeAbiParameters(types, args) }
}
const P_AB = pool(TOKEN_A, TOKEN_B)
const KEYS = new Map<string, RhPoolKey>([[P_AB.poolId, { currency0: P_AB.c0, currency1: P_AB.c1 }]])
let li = 0
const swapLog = (delta: Record<string, bigint>) => ({ address: PM, topics: [SWAP, P_AB.poolId, t(ROUTER)], data: `0x${int256(delta[P_AB.c0] ?? BigInt(0))}${int256(delta[P_AB.c1] ?? BigInt(0))}${'0'.repeat(256)}`, logIndex: li++, blockTimestamp: 1_760_000_000 })
const xfer = (token: string, from: string, to: string, amount: bigint) => ({ address: token, topics: [TRANSFER, t(from), t(to)], data: `0x${pad(amount.toString(16))}`, logIndex: li++, blockTimestamp: 1_760_000_000 })
const receipt = (from: string, logs: RhReceipt['logs'], to: string = ROUTER): RhReceipt => ({ status: 1, from, to, blockNumber: 100, gasUsed: BigInt(1), effectiveGasPrice: BigInt(1), logs })
const forensic = (r: RhReceipt, rejection: string | null = null) => buildRobinhoodSwapForensics({ wallet: WALLET, txHash: `0x${'ab'.repeat(32)}`, timestampSec: 1_760_000_000, receipt: r, poolManager: PM, poolKeys: KEYS, walletNativeDelta: null, rejectionReason: rejection })

const a = BigInt(10) * E18
const b = BigInt(20) * E18
const swapAB = () => swapLog({ [TOKEN_A]: -a, [TOKEN_B]: b })

test('1. direct wallet V4 swap -> A direct_wallet_swap', () => {
  const f = forensic(receipt(WALLET, [xfer(TOKEN_A, WALLET, PM, a), swapAB(), xfer(TOKEN_B, PM, WALLET, b)]))
  assert.equal(f.attributionClass, 'direct_wallet_swap')
  assert.equal(f.walletIsTxSender, true)
  assert.equal(f.routeUniquelyAttributable, true)
  assert.deepEqual([f.candidateInputToken, f.candidateInputRaw, f.candidateOutputToken, f.candidateOutputRaw], [TOKEN_A, a.toString(), TOKEN_B, b.toString()])
})

test('2. relayer sends the tx, wallet alone pays the exact input and receives the exact output -> B', () => {
  const f = forensic(receipt(RELAYER, [xfer(TOKEN_A, WALLET, PM, a), swapAB(), xfer(TOKEN_B, PM, WALLET, b)]), 'wallet_not_tx_sender')
  assert.equal(f.attributionClass, 'relayed_wallet_swap_proven')
  assert.equal(f.walletIsTxSender, false)
  assert.equal(f.walletIsDirectTokenPayer, true)
  assert.equal(f.walletIsDirectTokenRecipient, true)
  assert.equal(f.connectedWalletToV4Input && f.connectedV4OutputToWallet, true)
  assert.deepEqual(f.payerAddresses, [WALLET])
  assert.deepEqual(f.recipientAddresses, [WALLET])
  assert.equal(f.rejectionReason, 'wallet_not_tx_sender', 'forensics never changes the rejection')
})

test('3. wallet receives a token during someone else\'s swap -> C', () => {
  const f = forensic(receipt(OTHER, [xfer(TOKEN_A, OTHER, PM, a), swapAB(), xfer(TOKEN_B, PM, WALLET, b)]))
  assert.equal(f.attributionClass, 'wallet_transfer_inside_other_user_swap')
  assert.deepEqual(f.payerAddresses, [OTHER])
  assert.equal(f.routeUniquelyAttributable, false)
})

test('4. wallet supplies the input but another wallet receives the output -> C', () => {
  const f = forensic(receipt(RELAYER, [xfer(TOKEN_A, WALLET, PM, a), swapAB(), xfer(TOKEN_B, PM, OTHER, b)]))
  assert.equal(f.attributionClass, 'wallet_transfer_inside_other_user_swap')
  assert.deepEqual(f.recipientAddresses, [OTHER])
  assert.equal(f.walletIsDirectTokenRecipient, false)
})

test('5. another wallet supplies the input, the wallet receives the output (via a router) -> C', () => {
  const f = forensic(receipt(OTHER, [xfer(TOKEN_A, OTHER, ROUTER, a), xfer(TOKEN_A, ROUTER, PM, a), swapAB(), xfer(TOKEN_B, PM, ROUTER, b), xfer(TOKEN_B, ROUTER, WALLET, b)]))
  assert.equal(f.attributionClass, 'wallet_transfer_inside_other_user_swap')
  assert.ok(f.settlementAddresses.includes(ROUTER), 'the router is settlement, not an owner')
})

test('6. two possible payers (wallet and another wallet each fund half) -> not attributable', () => {
  const half = a / BigInt(2)
  const f = forensic(receipt(RELAYER, [xfer(TOKEN_A, WALLET, PM, half), xfer(TOKEN_A, OTHER, PM, half), swapAB(), xfer(TOKEN_B, PM, WALLET, b)]))
  assert.equal(f.attributionClass, 'ambiguous')
  assert.equal(f.routeUniquelyAttributable, false)
  assert.deepEqual(f.payerAddresses.sort(), [OTHER, WALLET].sort())
})

test('7. mixed V4 + a genuine other venue -> ambiguous; an other-venue-only tx is reported as other_only', () => {
  const mixed = forensic(receipt(WALLET, [xfer(TOKEN_A, WALLET, PM, a), swapAB(), { address: '0x4444444444444444444444444444444444444444', topics: [V3_SWAP, t(ROUTER), t(WALLET)], data: '0x', logIndex: li++, blockTimestamp: null }, xfer(TOKEN_B, PM, WALLET, b)]))
  assert.equal(mixed.attributionClass, 'ambiguous')
  assert.equal(mixed.venueMix, 'mixed')
  assert.equal(mixed.otherSwapVenueLogs[0].venue, 'uniswap_v3_style_swap')
  const otherOnly = forensic(receipt(WALLET, [xfer(TOKEN_A, WALLET, ROUTER, a), { address: '0x4444444444444444444444444444444444444444', topics: [V3_SWAP, t(ROUTER), t(WALLET)], data: '0x', logIndex: li++, blockTimestamp: null }, xfer(TOKEN_B, ROUTER, WALLET, b)]), 'other_venue_swap_in_tx')
  assert.equal(otherOnly.venueMix, 'other_only', 'no V4 at all: a plain V2/V3 trade, not a mixed-venue tx')
  assert.equal(otherOnly.v4SwapLogCount, 0)
  assert.equal(otherOnly.attributionClass, null)
})

test('8. router/helper noise is never ownership proof (router sends, funds and forwards; wallet only receives)', () => {
  const f = forensic(receipt(ROUTER, [xfer(TOKEN_A, ROUTER, PM, a), swapAB(), xfer(TOKEN_B, PM, ROUTER, b), xfer(TOKEN_B, ROUTER, WALLET, b)], ROUTER))
  assert.notEqual(f.attributionClass, 'relayed_wallet_swap_proven')
  assert.equal(f.attributionClass, 'wallet_transfer_inside_other_user_swap')
  assert.deepEqual(f.payerAddresses, [ROUTER])
  // and a relayed tx with a native leg is never B either (native is not visible in logs).
  const NP = pool(NATIVE, TOKEN_B)
  const keys = new Map<string, RhPoolKey>([[NP.poolId, { currency0: NP.c0, currency1: NP.c1 }]])
  const r = receipt(RELAYER, [{ address: PM, topics: [SWAP, NP.poolId, t(ROUTER)], data: `0x${int256(-E18)}${int256(b)}${'0'.repeat(256)}`, logIndex: li++, blockTimestamp: null }, xfer(TOKEN_B, PM, WALLET, b)])
  const n = buildRobinhoodSwapForensics({ wallet: WALLET, txHash: '0x01', timestampSec: null, receipt: r, poolManager: PM, poolKeys: keys, walletNativeDelta: BigInt(0), rejectionReason: null })
  assert.notEqual(n.attributionClass, 'relayed_wallet_swap_proven')
})

// ── End-to-end: acceptance unchanged, forensics logged per candidate ───────────────────────────────
beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('PnL V1 still rejects a relayed swap (wallet_not_tx_sender) and logs it as class B forensics', async () => {
  const hash = `0x${'cd'.repeat(32)}`
  const rcpt = {
    status: '0x1', from: RELAYER, to: ROUTER, blockNumber: '0x64', gasUsed: '0x1', effectiveGasPrice: '0x1',
    logs: [xfer(TOKEN_A, WALLET, PM, a), swapAB(), xfer(TOKEN_B, PM, WALLET, b)].map((l) => ({ ...l, logIndex: `0x${l.logIndex.toString(16)}`, blockTimestamp: '0x68e7c000' })),
  }
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') return p[0] === hash ? rcpt : null
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return P_AB.encoded
    return null
  })
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  let r
  try {
    r = await computeRobinhoodPnlV1({ wallet: WALLET, candidates: [{ txHash: hash, timestampMs: null, hasSwapLog: true }], transactionCount: 1, transferCount: 2, activityUnavailableReason: null, deps: { rpc, ethUsdRange: async () => null, tokenHistoricalUsd: async () => null, now: Date.now } })
  } finally { console.warn = w }
  assert.equal(r.swapsVerified, 0, 'acceptance unchanged')
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { wallet_not_tx_sender: 1 })
  assert.equal(r.ingestionAudit.v4AttributionClasses?.relayed_wallet_swap_proven, 1)
  const row = lines.find(([tag]) => tag === '[robinhood-swap-verification-forensics]')?.[1]
  assert.equal(row?.attributionClass, 'relayed_wallet_swap_proven')
  assert.equal(row?.txFrom, RELAYER)
  assert.equal(row?.txTo, ROUTER)
  assert.equal(row?.rejectionReason, 'wallet_not_tx_sender')
})
