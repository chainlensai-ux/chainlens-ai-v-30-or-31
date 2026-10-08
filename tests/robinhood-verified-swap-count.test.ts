// One canonical "verified Robinhood swaps" count: the V1 verifier's accepted swaps (direct V4, mixed route, relayed
// wallet-funded), one per tx. Every surface reads it through selectRobinhoodSwapEvidence; the older counters
// (activity.verifiedSwapCount = decode-time high-confidence swap LOGS; pnl/audit.verifiedSwapCount = both-leg priced
// PnL-gate count; decodedSwapCount / swapsFound = candidates) are never presented as verified swaps.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem'
import {
  selectRobinhoodSwapEvidence, robinhoodCompactProof, selectRobinhoodPnlLaneStatus, ROBINHOOD_PNL_PHASE3_SOURCE,
  type RobinhoodWalletScanResponse, type RobinhoodPnlSummary, type RobinhoodPnlVerificationAudit,
} from '../lib/walletScan/canonicalWalletSelectors.ts'
import { buildWalletPnlViewModel } from '../app/frontend/lib/buildWalletPnlViewModel.ts'
import { buildPnlLanes, buildWalletReadV2 } from '../app/frontend/lib/walletReadBuilder.ts'
import { RobinhoodChainSection } from '../app/frontend/components/RobinhoodChainSection.tsx'
import { SmartMoneyScoreCard } from '../app/frontend/components/SmartMoneyScoreCard.tsx'
import { formatCanonicalPnlEvidence } from '../lib/server/clarkRouting.ts'
import {
  computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0,
  type RhRpc, type RobinhoodPnlV1, type RobinhoodPnlV1Deps,
} from '../lib/server/robinhoodPnlV1.ts'
import {
  readRobinhoodVerifiedSwapManifest, recordRobinhoodVerifiedSwaps, __setRobinhoodVerifiedSwapManifestKvForTest,
} from '../lib/server/robinhoodVerifiedSwapManifest.ts'
import type { RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'
import type { SmartMoneyScore } from '../lib/engine/modules/smartMoney/types.ts'

delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

// ── UI fixture: canonical 3, while every older counter says something else ──────────────────────────────────────
const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
function summary(over: Partial<RobinhoodPnlSummary> = {}): RobinhoodPnlSummary {
  return {
    status: 'not_verified', structuralClosedLots: 0, verifiedClosedLots: 0, pricingCoverage: null, realizedPnlUsd: null, realizedRoiPct: null,
    unmatchedSellCount: 0, exactReason: '3 swaps proven, 3 priced on both legs, but no buy→sell pair closed a lot in this sample.',
    swapsFound: 7, swapsVerified: 3, swapsBothLegsPriced: 3, ...over,
  }
}
function result(over: { pnl?: Partial<RobinhoodPnlSummary>; activityVerified?: number; audit?: RobinhoodPnlVerificationAudit | null; legacyPnlVerified?: number } = {}): RobinhoodWalletScanResponse {
  return {
    ok: true, wallet: WALLET, chainSlug: 'robinhood', chainId: 4663,
    holdings: { status: 'ok', native: null, holdings: [], portfolioTotalUsd: 0, unpricedTokenCount: 0, reason: null },
    activity: {
      status: 'ok', items: [], skippedSwapLogs: 4, verifiedSwapCount: over.activityVerified ?? 1, reason: null,
      blockscoutEvidence: { blockscoutAttempted: false, blockscoutSucceeded: false, blockscoutFallbackUsed: false, blockscoutStatus: 'not_attempted', blockscoutError: null, blockscoutVerifiedSwap: false },
    },
    pnl: { status: 'disabled', message: '', realizedPnlUsd: null, matchedLotsCount: 0, verifiedSwapCount: over.legacyPnlVerified ?? 2, reason: null },
    robinhoodWalletScannerAudit: {},
    robinhoodPnlVerificationAudit: over.audit ?? null,
    robinhoodPnl: summary(over.pnl),
  }
}
function verifiedAudit(over: Partial<RobinhoodPnlVerificationAudit> = {}): RobinhoodPnlVerificationAudit {
  return {
    source: ROBINHOOD_PNL_PHASE3_SOURCE, chainId: 4663, wallet: WALLET, status: 'verified', realizedPnlUsd: 120,
    verifiedSwapCount: 2, decodedSwapCount: 7, swapsFedToFifo: 3, fifoClosedLots: 1, priceEvidenceBothLegsCount: 2, missingPriceEvidenceCount: 1,
    pnlEnabledReason: 'x', pnlDisabledReason: null, rejectedReasonIfNotVerified: null, ...over,
  } as RobinhoodPnlVerificationAudit
}
const sm = (over: Partial<SmartMoneyScore> = {}): SmartMoneyScore => ({
  status: 'not_yet_rated', officialScore: null, provisionalBehaviorScore: null,
  evidenceConfidence: { value: 0.1, level: 'low', fullyPricedTradeCount: 0, totalMatchedLotCount: 0, verifiedCoveragePercent: null, historyDays: null },
  breakdown: { verifiedProfitability: null, verifiedWinQuality: null, riskAdjustedPerformance: null, timingQuality: null, consistency: null, behaviorQuality: 65 },
  notes: [], reasonNotRated: 'x', ...over,
})
const section = (r: RobinhoodWalletScanResponse, debugMode = false) => renderToStaticMarkup(createElement(RobinhoodChainSection, { result: r, onRescan: () => {}, rescanLoading: false, debugMode }))
const readFor = (r: RobinhoodWalletScanResponse) => buildWalletReadV2({
  walletAddress: WALLET, scanTimestamp: null, chainsScanned: ['base'], behaviorIntel: null, finalSummary: null, totalValueUsd: 100,
  robinhoodIncluded: true, chainBreakdown: [], pricedTokenCount: 1, concentrationDetail: null, concentrationLabel: null, matchedLotsCount: 0,
  lastActiveMs: null, evmPnlLane: 'unavailable', robinhoodPnlLane: selectRobinhoodPnlLaneStatus(r), robinhoodDisplayState: 'valued', robinhoodResult: r,
  pnlConfidence: { realized: 'Locked', unrealized: 'Unavailable', historicalCoverage: 'Not available' } as never,
})

test('1. canonical 3 verified swaps → every surface renders 3 (activity counter 1, priced/gate counter 2, candidates 7 never leak)', () => {
  const r = result()
  assert.equal(selectRobinhoodSwapEvidence(r)!.swapsVerified, 3)
  const html = section(r)
  assert.ok(html.includes('Verified swaps: <strong style="color:#e2e8f0">3</strong>'), 'Activity card')
  assert.ok(!html.includes('Verified Robinhood swaps: '), 'the old activity counter label is gone')
  const read = readFor(r)
  assert.equal(read.keySignals.find((s) => s.label === 'Robinhood verified swaps')?.value, '3')
  assert.ok(read.evidence.verified.includes('3 Robinhood swaps verified'))
  const card = renderToStaticMarkup(createElement(SmartMoneyScoreCard, { smartMoneyScore: sm(), robinhoodVerifiedSwapCount: selectRobinhoodSwapEvidence(r)!.swapsVerified }))
  assert.ok(card.includes('>3 swaps verified — a verified swap is not a closed trade<'))
  assert.ok(buildPnlLanes({ evmPnlLane: 'unavailable', robinhoodPnlLane: 'not_verified', robinhoodResult: r })[1].detail.startsWith('3 swaps verified'))
  const clark = formatCanonicalPnlEvidence({ pnlStatus: 'unavailable', verifiedSwapCount: 0, robinhoodVerifiedSwapCount: 3, robinhoodPnlLaneStatus: 'not_verified', missingEvidence: [] } as never).join('\n')
  assert.ok(clark.includes('Robinhood verified swaps: 3 (swaps, not closed trades)'))
  assert.ok(clark.includes('Verified closed trades: 0') && !clark.includes('Verified trades:'))
})

test('1b. verified Robinhood lane: proof, view model, CORTEX lane and the section show the canonical count, not the priced gate count', () => {
  const r = result({ audit: verifiedAudit(), pnl: { status: 'verified_bounded_sample', structuralClosedLots: 1, verifiedClosedLots: 1, realizedPnlUsd: 120, swapsBothLegsPriced: 2 } })
  r.pnl = { ...r.pnl, status: 'verified', realizedPnlUsd: 120, verifiedSwapCount: 2, matchedLotsCount: 1 }
  assert.equal(selectRobinhoodPnlLaneStatus(r), 'verified')
  assert.equal(robinhoodCompactProof(r)!.verifiedSwapCount, 3)
  const vm = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: r, chainsScanned: [] })
  assert.equal(vm.robinhoodBox.proof!.verifiedSwaps, 3)
  assert.ok(vm.robinhoodBox.reason.startsWith('3 verified swaps'))
  assert.ok(buildPnlLanes({ evmPnlLane: 'unavailable', robinhoodPnlLane: 'verified', robinhoodResult: r })[1].detail.startsWith('3 verified swaps'))
  const html = section(r)
  assert.ok(html.includes('Verified swaps: <strong style="color:#e2e8f0">3</strong>'))
})

test('5. decodedSwapCount / swapsFound > verified never leaks into a verified label; decoded candidates are labelled as such', () => {
  const r = result({ pnl: { swapsFound: 7 }, activityVerified: 7 })
  const html = section(r, true)
  assert.ok(html.includes('Decoded swap candidates: <strong style="color:#e2e8f0">7</strong>'))
  assert.ok(html.includes('Verified swaps: <strong style="color:#e2e8f0">3</strong>'))
  assert.ok(!/Verified[^<]*swaps[^<]*: <strong[^>]*>7</.test(html))
  assert.ok(html.includes('activityDecoderHighConfidenceSwapLogs: 7'), 'the old per-log counter survives only in debug, renamed')
  assert.ok(!html.includes('verifiedSwapCount: 7'))
})

test('6. verified swaps ≠ verified closed trades', () => {
  const r = result()
  const html = section(r)
  assert.ok(html.includes('Closed trades: <strong style="color:#e2e8f0">0</strong>'))
  const card = renderToStaticMarkup(createElement(SmartMoneyScoreCard, { smartMoneyScore: sm(), robinhoodVerifiedSwapCount: 3 }))
  assert.ok(card.includes('Verified Closed Trades</div><div style="font-size:14px;font-weight:800;color:#e2e8f0">0 / 10 minimum'))
  assert.ok(card.includes('3 swaps verified'))
  const lots = selectRobinhoodSwapEvidence(result({ pnl: { structuralClosedLots: 2, verifiedClosedLots: 1 } }))!
  assert.deepEqual([lots.swapsVerified, lots.closedLots], [3, 2])
})

// ── Server: the canonical count is the verifier's own accepted-swap count ───────────────────────────────────────
const TS = 1790155166
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const RELAYER = '0x7777777777777777777777777777777777777777'
const A = '0xaaaa000000000000000000000000000000000001'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(Math.round(x * 1000)) * E18 / BigInt(1000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`
const H = (name: string) => keccak256(toHex(`swap-count-test:${name}`)).toLowerCase()
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
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: string; blockTimestamp: string }> = []
  txValue = BigInt(0)
  trace: RhNativeTransfer[] | null = []
  sender = WALLET
  to: string = ROUTER
  constructor(public ts: number) {}
  private i = 0
  private push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(this.ts) }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push(token, [ERC20_TRANSFER_TOPIC0, t(from), t(to)], `0x${uint(amt)}`) }
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint) {
    const p = poolId(inTok, outTok)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push(PM, [V4_SWAP_TOPIC0, p.id, t(ROUTER)], `0x${int256(d[p.c0])}${int256(d[p.c1])}${'0'.repeat(256)}`)
  }
}
const pay = (from: string, to: string, value: bigint): RhNativeTransfer => ({ from, to, value, success: true })
function directBuy(eth: bigint, amount: bigint, ts: number) { const tx = new Tx(ts).v4(RH_NATIVE, A, eth, amount).xfer(A, PM, WALLET, amount); tx.txValue = eth; return tx }
function relayedBuy(eth: bigint, amount: bigint, ts: number, opts: { to?: string; value?: bigint } = {}) {
  const tx = new Tx(ts).v4(RH_NATIVE, A, eth, amount).xfer(A, PM, WALLET, amount)
  tx.sender = RELAYER
  tx.to = opts.to ?? ROUTER
  tx.txValue = opts.value ?? BigInt(0)
  tx.trace = [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)]
  return tx
}

class HashKv {
  store = new Map<string, Map<string, unknown>>()
  async hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    const h = this.store.get(key)
    return h && h.size ? Object.fromEntries([...h].map(([k, v]) => [k, typeof v === 'string' ? JSON.parse(v) : v])) as T : null
  }
  async hset(key: string, fields: Record<string, unknown>): Promise<number> {
    const h = this.store.get(key) ?? new Map<string, unknown>()
    for (const [k, v] of Object.entries(fields)) h.set(k, v)
    this.store.set(key, h)
    return 1
  }
}

async function runV1(specs: Array<[string, Tx]>, opts: { activity: string[]; stored?: Set<string>; manifest?: boolean }): Promise<RobinhoodPnlV1> {
  __resetRobinhoodPnlV1CachesForTest()
  const chain = new Map(specs.map(([name, tx]) => [H(name), { name, tx, block: 1000 + (tx.ts - TS) }]))
  const byBlock = new Map([...chain.values()].map((v) => [v.block, v]))
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') { const e = chain.get(p[0]); return e ? { status: '0x1', from: e.tx.sender, to: e.tx.to, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null }
    if (method === 'eth_getTransactionByHash') { const e = chain.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return byBlock.get(Number(p[1]))?.tx.sender === WALLET ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const deps: RobinhoodPnlV1Deps = {
    rpc, now: () => 1_800_000_000_000, tokenHistoricalUsd: async () => null, ethUsdRange: async () => null,
    ethUsdAt: async (ts) => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: 0, maxAllowedGapMs: 86_400_000 }),
    nativeTransfersForTx: async (h) => chain.get(h)!.tx.trace,
    nativeTraceCached: async (h) => { const e = chain.get(h); return e && opts.stored?.has(e.name) && e.tx.trace ? { transfers: e.tx.trace, audit: null } : null },
    ...(opts.manifest ? { verifiedSwapManifest: { read: readRobinhoodVerifiedSwapManifest, record: recordRobinhoodVerifiedSwaps } } : {}),
  }
  const w = console.warn
  console.warn = () => {}
  try {
    return await computeRobinhoodPnlV1({
      wallet: WALLET, transactionCount: opts.activity.length, transferCount: opts.activity.length, activityUnavailableReason: null, deps,
      candidates: opts.activity.map((name) => ({ txHash: H(name), timestampMs: chain.get(H(name))!.tx.ts * 1000, hasSwapLog: true })),
    })
  } finally { console.warn = w }
}
const asUi = (v1: RobinhoodPnlV1) => selectRobinhoodSwapEvidence(result({ pnl: { swapsFound: v1.swapsFound, swapsVerified: v1.swapsVerified, swapsBothLegsPriced: v1.swapsBothLegsPriced } }))!.swapsVerified

let kv: HashKv
beforeEach(() => { kv = new HashKv(); __setRobinhoodVerifiedSwapManifestKvForTest(kv) })

test('2. an accepted relayed swap counts exactly once (live trace, and again with stored-trace reuse)', async () => {
  const specs: Array<[string, Tx]> = [['relayed', relayedBuy(n(0.01), n(1000), TS + 10)], ['direct', directBuy(n(0.02), n(2000), TS + 20)]]
  const live = await runV1(specs, { activity: ['relayed', 'direct'] })
  assert.equal(live.ingestionAudit.relayedWalletVerifiedSwapCount, 1)
  assert.equal(live.ingestionAudit.directV4VerifiedSwapCount, 1)
  assert.deepEqual([live.swapsVerified, live.ingestionAudit.verifiedSwapTxCount, asUi(live)], [2, 2, 2])
  const stored = await runV1(specs, { activity: ['relayed', 'direct'], stored: new Set(['relayed', 'direct']) })
  assert.deepEqual([stored.swapsVerified, stored.ingestionAudit.relayedWalletVerifiedSwapCount, asUi(stored)], [2, 1, 2], 'stored-trace replay never double counts')
})

test('3. an externally funded relayed candidate counts 0', async () => {
  const eth = n(1)
  const v1 = await runV1([['ext', relayedBuy(eth, n(1000), TS + 10, { to: WALLET, value: eth })]], { activity: ['ext'] })
  assert.equal(v1.ingestionAudit.relayedNativeTraceDiagnostics?.verdicts.externally_funded_route, 1)
  assert.deepEqual([v1.swapsVerified, v1.ingestionAudit.relayedWalletVerifiedSwapCount, asUi(v1)], [0, 0, 0])
  assert.ok(v1.swapsFound >= 1, 'it is still a decoded candidate — just not a verified swap')
})

test('4. manifest replay of the same tx does not increment the count', async () => {
  const specs: Array<[string, Tx]> = [['relayed', relayedBuy(n(0.01), n(1000), TS + 10)], ['direct', directBuy(n(0.02), n(2000), TS + 20)]]
  const first = await runV1(specs, { activity: ['relayed', 'direct'], manifest: true })
  assert.equal(first.swapsVerified, 2)
  // same txs now in BOTH the manifest and current activity, with stored traces
  const replay = await runV1(specs, { activity: ['relayed', 'direct'], manifest: true, stored: new Set(['relayed', 'direct']) })
  assert.equal(replay.ingestionAudit.candidateSelection!.selectedCandidates.length, 2, 'one slot per tx')
  assert.deepEqual([replay.swapsVerified, replay.ingestionAudit.verifiedSwapTxCount, asUi(replay)], [2, 2, 2])
  // manifest-only (absent from activity): still once
  const manifestOnly = await runV1(specs, { activity: [], manifest: true, stored: new Set(['relayed', 'direct']) })
  assert.deepEqual([manifestOnly.swapsVerified, asUi(manifestOnly)], [2, 2])
})
