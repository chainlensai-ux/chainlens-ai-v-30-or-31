// Robinhood swap-history coverage: the staged (budgeted) verifier continues past the first 20 candidates, every
// verified-swap count carries its candidate coverage, relayed routes are accepted only on receipt/trace proof (a
// receipt-only token route, or a traced token → ETH sell), and buys / sells stay separate from closed trades.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import {
  computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, orderRobinhoodStagedCandidates, robinhoodVerificationCoverage,
  ROBINHOOD_PNL_V1_LIMITS, RH_NATIVE, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0,
  type RhRpc, type RhEthUsdPoint, type RobinhoodPnlV1, type RobinhoodPnlV1Candidate,
} from '../lib/server/robinhoodPnlV1.ts'
import type { RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'
import { robinhoodVerifiedSwapsText, robinhoodCoverageLabel, selectRobinhoodSwapEvidence, type RobinhoodWalletScanResponse } from '../lib/walletScan/canonicalWalletSelectors.ts'
import { buildEvidence } from '../app/frontend/lib/walletReadBuilder.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const TS = 1790155166
const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const RELAYER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(Math.round(x * 1000)) * E18 / BigInt(1000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`
const hashN = (i: number) => `0x${(0xc0de0000 + i).toString(16).padStart(64, '0')}`

const POOLS = new Map<string, string>()
function poolId(x: string, y: string) {
  const [c0, c1] = [x, y].sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  const id = keccak256(encodeAbiParameters(types, args)).toLowerCase()
  POOLS.set(id, encodeAbiParameters(types, args))
  return { id, c0, c1 }
}

class Tx {
  logs: unknown[] = []
  txValue = BigInt(0)
  trace: RhNativeTransfer[] | null = []
  sender = WALLET
  to: string = ROUTER
  private i = 0
  constructor(public ts = TS) {}
  private push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(this.ts) }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push(token, [ERC20_TRANSFER_TOPIC0, t(from), t(to)], `0x${uint(amt)}`) }
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint) {
    const p = poolId(inTok, outTok)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push(PM, [V4_SWAP_TOPIC0, p.id, t(ROUTER)], `0x${int256(d[p.c0])}${int256(d[p.c1])}${'0'.repeat(256)}`)
  }
  by(sender: string) { this.sender = sender; return this }
}
const noSwap = (ts = TS) => new Tx(ts) // a wallet tx with no token movement through a V4 pool
const directBuy = (token: string, eth: bigint, amount: bigint, ts = TS) => { const tx = new Tx(ts).v4(RH_NATIVE, token, eth, amount).xfer(token, PM, WALLET, amount); tx.txValue = eth; tx.trace = [{ from: WALLET, to: ROUTER, value: eth, success: true }]; return tx }
// Relayed token → token: the wallet supplies A, receives B, on one A/B V4 pool (no native leg).
const relayedTokenSwap = (inAmt: bigint, outAmt: bigint, received = outAmt, ts = TS) =>
  new Tx(ts).xfer(A, WALLET, PM, inAmt).v4(A, B, inAmt, outAmt).xfer(B, PM, WALLET, received).by(RELAYER)
// Relayed token → ETH: the wallet supplies the token; the exact trace shows the router paying it the ETH.
const relayedSell = (token: string, amount: bigint, ethOut: bigint, ts = TS) => {
  const tx = new Tx(ts).xfer(token, WALLET, PM, amount).v4(token, RH_NATIVE, amount, ethOut).by(RELAYER)
  tx.trace = [{ from: PM, to: ROUTER, value: ethOut, success: true }, { from: ROUTER, to: WALLET, value: ethOut, success: true }]
  return tx
}
// Relayed ETH → token buy, the wallet's own native debit in the exact trace.
const relayedBuy = (token: string, eth: bigint, amount: bigint, ts = TS) => {
  const tx = new Tx(ts).v4(RH_NATIVE, token, eth, amount).xfer(token, PM, WALLET, amount).by(RELAYER)
  tx.trace = [{ from: WALLET, to: ROUTER, value: eth, success: true }, { from: ROUTER, to: PM, value: eth, success: true }]
  return tx
}

const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })

type Row = { tx: Tx; hasSwapLog?: boolean; hash?: string; timestampMs?: number | null }
async function run(rows: Row[], opts: { extraCandidates?: RobinhoodPnlV1Candidate[] } = {}) {
  __resetRobinhoodPnlV1CachesForTest()
  const byHash = new Map(rows.map((r, i) => [r.hash ?? hashN(i), { ...r, block: 1000 + i * 10 }]))
  const receiptCalls = new Map<string, number>()
  let rpcCalls = 0
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    rpcCalls += 1
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') {
      receiptCalls.set(p[0], (receiptCalls.get(p[0]) ?? 0) + 1)
      const e = byHash.get(p[0])
      return e ? { status: '0x1', from: e.tx.sender, to: e.tx.to, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null
    }
    if (method === 'eth_getTransactionByHash') { const e = byHash.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const candidates: RobinhoodPnlV1Candidate[] = [
    ...rows.map((r, i) => ({ txHash: r.hash ?? hashN(i), timestampMs: r.timestampMs === undefined ? (TS - i) * 1000 : r.timestampMs, hasSwapLog: r.hasSwapLog ?? false })),
    ...(opts.extraCandidates ?? []),
  ]
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  let r: RobinhoodPnlV1
  try {
    r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates, transactionCount: candidates.length, transferCount: candidates.length, activityUnavailableReason: null,
      deps: {
        rpc, now: Date.now, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null,
        nativeTransfersForTx: async (h) => byHash.get(h)?.tx.trace ?? null,
      },
    })
  } finally { console.warn = w }
  return { r, receiptCalls, rpcCalls, staged: lines.find(([tag]) => tag === '[robinhood-staged-verification-audit]')?.[1] }
}
const asResponse = (r: RobinhoodPnlV1): RobinhoodWalletScanResponse => ({
  ok: true, wallet: WALLET, chainSlug: 'robinhood', chainId: 4663,
  holdings: { status: 'ok', wallet: WALLET, chainSlug: 'robinhood', chainId: 4663, native: null, holdings: [], portfolioTotalUsd: null, unpricedTokenCount: 0, reason: null, fromCache: false },
  activity: { status: 'ok', items: [], reason: null },
  pnl: { status: 'disabled', message: '', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: 0, reason: r.exactReason },
  robinhoodPnl: r,
} as unknown as RobinhoodWalletScanResponse)

test('1+8. 78 candidates: the verified-swap count always carries its coverage (no silent "3 verified swaps")', async () => {
  const rows: Row[] = Array.from({ length: 78 }, () => ({ tx: noSwap() }))
  rows[0] = { tx: directBuy(A, n(0.01), n(100)), hasSwapLog: true }
  const { r } = await run(rows)
  const L = ROBINHOOD_PNL_V1_LIMITS
  const checked = L.maxCandidateReceipts + L.maxStagedReceipts
  assert.equal(r.ingestionAudit.candidatesConsidered, 78)
  assert.equal(r.ingestionAudit.candidatesVerified, checked)
  assert.equal(r.ingestionAudit.candidatesDroppedByBudget, 78 - checked)
  assert.equal(r.ingestionAudit.verificationCoveragePct, Math.round((checked / 78) * 1000) / 10)
  assert.equal(r.verificationCoverage?.complete, false)
  const ev = selectRobinhoodSwapEvidence(asResponse(r))!
  assert.equal(ev.swapsVerified, 1)
  assert.equal(robinhoodVerifiedSwapsText(ev.swapsVerified, ev.coverage), `1 verified swap · ${checked}/78 candidates checked`)
  const evidence = buildEvidence({
    hasHoldingsData: true, pnlConfidence: { realized: 'Partial', unrealized: 'Unavailable', historicalCoverage: 'Not available' } as never,
    robinhoodDisplayState: 'valued', robinhoodPnlLane: 'not_verified', matchedLotsCount: 0, robinhoodSwapEvidence: ev,
  })
  assert.ok(evidence.verified.some((v) => v.includes(`(${checked}/78 candidates checked)`)), evidence.verified.join(' | '))
  // Complete coverage drops the label.
  assert.equal(robinhoodCoverageLabel({ ...ev.coverage!, candidatesChecked: 78, candidatesDroppedByBudget: 0, complete: true }), null)
})

test('2. the staged verifier continues beyond 20 and finds a swap the old hard cap dropped', async () => {
  const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({ tx: noSwap(), hasSwapLog: i < 25 }))
  rows[27] = { tx: directBuy(A, n(0.01), n(100), TS - 27) } // ranked after 20 swap-log rows → dropped by the old cap
  const { r, staged } = await run(rows)
  assert.equal(r.swapsVerified, 1, 'the 28th candidate is verified in stage 2')
  assert.equal(staged.stage1Checked, 20)
  assert.equal(staged.stage2Checked, 10)
  assert.equal(staged.stage2StopReason, 'complete')
  assert.equal(r.verificationCoverage?.complete, true)
})

test('3. a duplicate tx hash is fetched and verified once', async () => {
  const buy = directBuy(A, n(0.01), n(100))
  const h = hashN(0)
  const { r, receiptCalls } = await run([{ tx: buy, hasSwapLog: true, hash: h }], {
    extraCandidates: [{ txHash: h, timestampMs: null, hasSwapLog: false }, { txHash: h.toUpperCase().replace('0X', '0x'), timestampMs: TS * 1000, hasSwapLog: true }],
  })
  assert.equal(receiptCalls.get(h), 1)
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.candidatesConsidered, 1)
})

test('4. a relayed wallet-funded token route is proven from its receipt and counted once', async () => {
  const h = hashN(0)
  const { r } = await run([{ tx: relayedTokenSwap(n(50), n(20)), hasSwapLog: true, hash: h }], { extraCandidates: [{ txHash: h, timestampMs: null, hasSwapLog: true }] })
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.rejectionReasons.wallet_not_tx_sender ?? 0, 0)
  assert.equal(r.ingestionAudit.v4AttributionClasses?.relayed_wallet_swap_proven, 1)
})

test('5. externally funded or partially paid-out relayed routes stay wallet_not_tx_sender', async () => {
  // The input token was supplied by another address — the wallet only received the output.
  const external = new Tx().xfer(A, OTHER, PM, n(50)).v4(A, B, n(50), n(20)).xfer(B, PM, WALLET, n(20)).by(RELAYER)
  // The wallet received only part of the route output (the rest went elsewhere): no tax leeway for relayed routes.
  const skimmed = relayedTokenSwap(n(50), n(20), n(15))
  // A relayed ETH → token buy whose exact trace shows the RELAYER paying the native input.
  const relayerPaid = relayedBuy(A, n(0.01), n(100))
  relayerPaid.trace = [{ from: RELAYER, to: ROUTER, value: n(0.01), success: true }, { from: ROUTER, to: PM, value: n(0.01), success: true }]
  const { r } = await run([{ tx: external, hasSwapLog: true }, { tx: skimmed, hasSwapLog: true }, { tx: relayerPaid, hasSwapLog: true }])
  assert.equal(r.swapsVerified, 0)
  assert.equal(r.ingestionAudit.rejectionReasons.wallet_not_tx_sender, 3)
})

test('6+7. a traced relayed token → ETH route normalizes as a sell; buys / sells stay separate from closed trades', async () => {
  const { r } = await run([
    { tx: relayedBuy(A, n(0.01), n(100), TS - 100), hasSwapLog: true },
    { tx: relayedSell(A, n(100), n(0.02), TS), hasSwapLog: true },
  ])
  assert.equal(r.swapsVerified, 2)
  assert.equal(r.ingestionAudit.normalizedBuyCount, 1)
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
  assert.equal(r.verificationCoverage?.verifiedBuys, 1)
  assert.equal(r.verificationCoverage?.verifiedSells, 1)
  assert.equal(r.structuralClosedLots, 1, 'one buy→sell lot closes; buys / sells are counted separately from it')
})

test('6b. a relayed sell whose trace shows the wallet also paying native is not accepted', async () => {
  const tx = relayedSell(A, n(100), n(0.02))
  tx.trace = [...tx.trace!, { from: WALLET, to: OTHER, value: n(0.001), success: true }]
  const { r } = await run([{ tx, hasSwapLog: true }])
  assert.equal(r.swapsVerified, 0)
  assert.equal(r.ingestionAudit.normalizedSellCount, 0)
})

test('9. stage 2 respects its receipt and RPC budgets', async () => {
  const L = ROBINHOOD_PNL_V1_LIMITS
  // Relayed native-pool receipts each pull the existing per-receipt evidence batch — the expensive kind.
  const rows: Row[] = Array.from({ length: 200 }, (_, i) => ({ tx: i % 2 ? relayedBuy(A, n(0.01), n(100) + BigInt(i)) : noSwap(), hasSwapLog: true }))
  const { staged, r } = await run(rows)
  assert.ok(staged.stage2Checked <= L.maxStagedReceipts)
  assert.ok(staged.stage2RpcCalls <= L.maxStagedRpcCalls, `stage-2 rpc calls ${staged.stage2RpcCalls}`)
  assert.ok(['receipt_budget', 'rpc_budget'].includes(staged.stage2StopReason))
  assert.equal(r.ingestionAudit.candidatesDroppedByBudget, 200 - (r.ingestionAudit.candidatesVerified ?? 0))
})

test('stage-2 order: manifest hashes, then swap logs, then wallet token flow, then the rest; deduped', () => {
  const c = (i: number, extra: Partial<RobinhoodPnlV1Candidate> = {}): RobinhoodPnlV1Candidate => ({ txHash: hashN(i), timestampMs: i * 1000, hasSwapLog: false, ...extra })
  const order = orderRobinhoodStagedCandidates(
    [hashN(1), hashN(2), hashN(3), hashN(4), hashN(2)],
    [c(1), c(2, { hasWalletTokenFlow: true }), c(3, { hasSwapLog: true }), c(4)],
    new Set([hashN(4)]),
  )
  assert.deepEqual(order.map((o) => o.tier), ['manifest', 'swap_log', 'wallet_token_flow', 'other'])
  assert.deepEqual(order.map((o) => o.txHash), [hashN(4), hashN(3), hashN(2), hashN(1)])
  assert.deepEqual(robinhoodVerificationCoverage(78, 20), { candidatesConsidered: 78, candidatesChecked: 20, candidatesDroppedByBudget: 58, verificationCoveragePct: 25.6, complete: false })
})
