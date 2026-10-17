// Sell-proof lane timing: start gate, hard deadline, snapshot ordering, scan context, timeout fallback.
//   npx tsx --test src/modules/receiptSwapDecoder/sellReceiptProofTiming.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  planSellProofLane, proveSellsFromReceipts, waitForSnapshotBeforeCutoff,
  SELL_PROOF_LANE_BUDGET_MS, SELL_PROOF_MIN_REMAINING_MS, SELL_PROOF_RESERVE_MS,
} from './sellReceiptProof'
import { currentScanContext, runWithScanContext } from '../../lib/scanRunContext'
import { attachHeavyWalletFollowUp } from '../heavyWalletFollowUp'
import { globalTimeoutPartialResult } from '../../../workers/walletScanV2'
import { WALLET, ROUTER, POOL_A, TOKEN_X, transferLog, classicSwapLog } from './fixtures.test-helpers'
import type { WalletScanJobPayload } from '../walletScanQueue'

const WETH = '0x4200000000000000000000000000000000000006'
const sellLogs = () => [transferLog(0, TOKEN_X, WALLET, POOL_A, BigInt(1000)), transferLog(1, WETH, POOL_A, ROUTER, BigInt(5)), classicSwapLog(2, POOL_A, ROUTER, BigInt(1000), BigInt(0), BigInt(0), BigInt(5))]
const candidate = (b: string) => ({ chain: 'base', txHash: `0x${b.repeat(32)}`, token: TOKEN_X, timestamp: '2026-01-01T00:00:00Z', hasPriorInventory: true })

describe('planSellProofLane', () => {
  it('needs the lane budget plus the reserve before the global deadline', () => {
    assert.equal(SELL_PROOF_MIN_REMAINING_MS, SELL_PROOF_LANE_BUDGET_MS + SELL_PROOF_RESERVE_MS)
    const now = 1_000_000
    assert.deepEqual(planSellProofLane(now, now + SELL_PROOF_MIN_REMAINING_MS - 1), { run: false, reason: 'insufficient_time_before_global_deadline', remainingMs: SELL_PROOF_MIN_REMAINING_MS - 1 })
    assert.deepEqual(planSellProofLane(now, now + 200_000), { run: true, hardDeadlineAtMs: now + 200_000 - SELL_PROOF_RESERVE_MS, remainingMs: 200_000 })
  })
  it('without a worker deadline (routes, tests) the lane keeps only its own budget', () => {
    assert.deepEqual(planSellProofLane(5, undefined), { run: true, hardDeadlineAtMs: undefined, remainingMs: null })
  })
})

describe('waitForSnapshotBeforeCutoff', () => {
  it('true once the snapshot settles (even if it failed), false at the cutoff', async () => {
    assert.equal(await waitForSnapshotBeforeCutoff(Promise.resolve(), Date.now() + 1000), true)
    assert.equal(await waitForSnapshotBeforeCutoff(Promise.reject(new Error('x')), Date.now() + 1000), true)
    assert.equal(await waitForSnapshotBeforeCutoff(new Promise(() => {}), Date.now() + 30), false)
    assert.equal(await waitForSnapshotBeforeCutoff(Promise.resolve(), Date.now() - 1), false)
  })
})

describe('proveSellsFromReceipts hard deadline', () => {
  it('returns at the deadline even when a pool validation never answers; the stuck check stays unproven', async () => {
    const started = Date.now()
    const out = await proveSellsFromReceipts({
      candidates: [candidate('a7')], walletAddress: WALLET,
      fetchReceipt: async () => ({ status: 'ok', logs: sellLogs() }),
      validator: { isValidPool: () => new Promise<boolean>(() => {}) },
      laneBudgetMs: 60_000, hardDeadlineAtMs: Date.now() + 80,
    })
    assert.ok(Date.now() - started < 2_000)
    assert.equal(out.provenTxKeys.size, 0)
    assert.equal(out.audit.stopReason, 'hard_deadline')
    assert.equal(out.audit.abandonedInFlight, 1)
    assert.ok(out.audit.elapsedMs >= 0)
  })
  it('a deadline already past starts nothing', async () => {
    let fetches = 0
    const out = await proveSellsFromReceipts({
      candidates: [candidate('a8')], walletAddress: WALLET,
      fetchReceipt: async () => { fetches += 1; return { status: 'ok', logs: sellLogs() } },
      validator: { isValidPool: async () => true }, hardDeadlineAtMs: Date.now() - 1,
    })
    assert.equal(fetches, 0)
    assert.equal(out.audit.skippedByTimeBudget, 1)
  })
  it('proof results are unchanged when everything finishes in time, with per-step timings', async () => {
    const out = await proveSellsFromReceipts({ candidates: [candidate('a9')], walletAddress: WALLET, fetchReceipt: async () => ({ status: 'ok', logs: sellLogs() }), validator: { isValidPool: async () => true } })
    assert.equal(out.audit.proofs.exact_swap, 1)
    assert.equal(out.audit.stopReason, 'completed')
    assert.deepEqual(Object.keys(out.audit.stepMs).sort(), ['fetch', 'prove', 'v4', 'venue'])
  })
})

describe('scan run context', () => {
  it('is visible across awaits inside the run and absent outside it', async () => {
    assert.equal(currentScanContext(), undefined)
    const seen = await runWithScanContext({ deadlineAtMs: 42 }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      return currentScanContext()?.deadlineAtMs
    })
    assert.equal(seen, 42)
  })
})

describe('global timeout after the snapshot', () => {
  const payload: WalletScanJobPayload = { jobId: 'job-1', userId: 'u', walletAddress: WALLET, chains: ['base'], scanMode: 'normal', ip: '1.1.1.1' }
  it('queues a follow-up and marks PnL still processing', async () => {
    const queued: string[] = []
    const out = await attachHeavyWalletFollowUp(globalTimeoutPartialResult(true).body, payload, async (id, p) => { queued.push(`${id}:${p.heavyWalletFollowUp}`) }, () => 'f-1') as Record<string, unknown>
    assert.deepEqual(queued, ['f-1:true'])
    assert.equal(out.pnlStillProcessing, true)
    assert.equal(out.pnlFollowUpJobId, 'f-1')
  })
  it('no snapshot, or already a follow-up: nothing queued, result unchanged', async () => {
    let calls = 0
    const enqueue = async () => { calls += 1 }
    const noSnapshot = globalTimeoutPartialResult(false).body
    assert.equal(await attachHeavyWalletFollowUp(noSnapshot, payload, enqueue), noSnapshot)
    const timedOut = globalTimeoutPartialResult(true).body
    assert.equal(await attachHeavyWalletFollowUp(timedOut, { ...payload, heavyWalletFollowUp: true }, enqueue), timedOut)
    assert.equal(calls, 0)
  })
  it('enqueue failure falls back to the existing "scan did not finish" state', async () => {
    const out = await attachHeavyWalletFollowUp(globalTimeoutPartialResult(true).body, payload, async () => { throw new Error('kv') }) as Record<string, unknown>
    assert.equal(out.pnlStillProcessing, false)
  })
})

describe('wiring (source checks)', () => {
  const root = path.resolve(__dirname, '../../..')
  const pipeline = readFileSync(path.join(root, 'src/pipeline/index.ts'), 'utf8')
  const worker = readFileSync(path.join(root, 'workers/walletScanV2.ts'), 'utf8')
  const page = readFileSync(path.join(root, 'app/terminal/wallet-scanner/page.tsx'), 'utf8')
  it('the pipeline waits for the published snapshot, then checks remaining time, before the lane', () => {
    const wait = pipeline.indexOf('waitForSnapshotBeforeCutoff(scanContext.snapshotPublished')
    const plan = pipeline.indexOf('planSellProofLane(Date.now(), scanContext?.deadlineAtMs)')
    const lane = pipeline.indexOf('proveSellsFromReceipts({')
    assert.ok(wait > 0 && wait < plan && plan < lane)
    assert.match(pipeline, /hardDeadlineAtMs: plan\.hardDeadlineAtMs/)
  })
  it('the worker runs the core inside the scan context with the snapshot promise and logs stage timing', () => {
    assert.match(worker, /runWithScanContext\(\{ deadlineAtMs: startTime \+ WORKER_GLOBAL_TIMEOUT_MS, snapshotPublished: fastSnapshotPromise, historicalPricePriority: nativePricePriorityReady \}/)
    assert.match(worker, /globalTimeoutPartialResult\(snapshot\?\.partialSnapshotPublished === true\)/)
    assert.match(worker, /workerStageTiming: timing/)
    assert.match(worker, /\[worker-stage-timing\]/)
  })
  it('the page shows "PnL still processing" instead of the error banner on a timed-out scan with a follow-up', () => {
    assert.match(page, /response\.pnlStillProcessing && response\.pnlFollowUpJobId/)
    assert.match(page, /Portfolio snapshot · PnL still processing/)
  })
})
