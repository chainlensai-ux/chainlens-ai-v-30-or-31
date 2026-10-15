// Heavy wallets: deferral decision (workers/walletScanV2.ts) and the follow-up job hand-off.
//   npx tsx --test src/modules/heavyWalletFollowUp.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { attachHeavyWalletFollowUp, HEAVY_WALLET_DEFERRED_PNL_STATUS } from './heavyWalletFollowUp'
import { HEAVY_WALLET_EVENT_THRESHOLD, shouldDeferHeavyWallet } from '../../workers/walletScanV2'
import type { WalletScanJobPayload } from './walletScanQueue'

const diag = (...alchemyCounts: number[]) => alchemyCounts.map((eventCount) => ({ goldrush: { eventCount: 500 }, alchemy: { eventCount } }))
const payload: WalletScanJobPayload = { jobId: 'job-1', userId: 'u1', walletAddress: '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811', chains: ['base', 'eth'], scanMode: 'normal', ip: '1.2.3.4', includeRobinhoodRequested: true }
const deferredBody = () => ({ success: true, data: { pnlStatus: HEAVY_WALLET_DEFERRED_PNL_STATUS, heavyWalletDeferral: { eventCount: 5000, threshold: HEAVY_WALLET_EVENT_THRESHOLD }, chainHoldings: [{ symbol: 'X' }] } })

describe('shouldDeferHeavyWallet', () => {
  it('threshold covers a full paginated chain (no longer the pre-pagination 800)', () => {
    assert.ok(HEAVY_WALLET_EVENT_THRESHOLD >= 2400)
  })
  it('0xd40e… (1,625 Alchemy transfers on Base) runs the full scan', () => {
    assert.equal(shouldDeferHeavyWallet(diag(1625, 0)), false)
  })
  it('defers only above the threshold, summed across chains (GoldRush not counted)', () => {
    assert.equal(shouldDeferHeavyWallet(diag(HEAVY_WALLET_EVENT_THRESHOLD, 0)), false)
    assert.equal(shouldDeferHeavyWallet(diag(HEAVY_WALLET_EVENT_THRESHOLD, 1)), true)
  })
  it('the follow-up job never defers again', () => {
    assert.equal(shouldDeferHeavyWallet(diag(9999, 9999), { heavyWalletFollowUp: true }), false)
  })
  it('missing diagnostics never defer', () => {
    assert.equal(shouldDeferHeavyWallet(undefined), false)
  })
})

describe('attachHeavyWalletFollowUp', () => {
  it('queues one follow-up job for the same wallet and puts its id on the result', async () => {
    const calls: Array<[string, WalletScanJobPayload]> = []
    const out = await attachHeavyWalletFollowUp(deferredBody(), payload, async (id, p) => { calls.push([id, p]) }, () => 'follow-1') as { success: boolean; data: Record<string, unknown> }
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'follow-1')
    assert.equal(calls[0][1].jobId, 'follow-1')
    assert.equal(calls[0][1].walletAddress, payload.walletAddress)
    assert.equal(calls[0][1].userId, payload.userId)
    assert.equal(calls[0][1].heavyWalletFollowUp, true)
    assert.equal(out.success, true)
    assert.equal(out.data.pnlFollowUpJobId, 'follow-1')
    assert.equal((out.data.heavyWalletDeferral as { followUp: string }).followUp, 'queued')
    assert.deepEqual(out.data.chainHoldings, [{ symbol: 'X' }]) // holdings kept
  })
  it('an enqueue failure keeps the holdings result and says so', async () => {
    const out = await attachHeavyWalletFollowUp(deferredBody(), payload, async () => { throw new Error('kv down') }, () => 'f') as { success: boolean; data: Record<string, unknown> }
    assert.equal(out.success, true)
    assert.equal(out.data.pnlFollowUpJobId, null)
    assert.equal((out.data.heavyWalletDeferral as { followUp: string }).followUp, 'enqueue_failed')
  })
  it('leaves normal results, failures and follow-up results untouched', async () => {
    let calls = 0
    const enqueue = async () => { calls += 1 }
    const normal = { success: true, data: { pnlStatus: 'verified' } }
    assert.equal(await attachHeavyWalletFollowUp(normal, payload, enqueue), normal)
    const failed = { success: false, error: { message: 'x' } }
    assert.equal(await attachHeavyWalletFollowUp(failed, payload, enqueue), failed)
    const body = deferredBody()
    assert.equal(await attachHeavyWalletFollowUp(body, { ...payload, heavyWalletFollowUp: true }, enqueue), body)
    assert.equal(calls, 0)
  })
})

describe('wiring (source checks)', () => {
  const root = path.resolve(__dirname, '../..')
  const worker = readFileSync(path.join(root, 'workers/walletScanV2.ts'), 'utf8')
  const runner = readFileSync(path.join(root, 'src/modules/walletScanWorker.ts'), 'utf8')
  const page = readFileSync(path.join(root, 'app/terminal/wallet-scanner/page.tsx'), 'utf8')

  it('the worker no longer fails heavy wallets', () => {
    assert.doesNotMatch(worker, /message: 'HEAVY_WALLET_FAST_FAIL'/)
  })
  it('the worker skips every V2 analysis module when deferred', () => {
    for (const name of ['pnl', 'chainActivity', 'risk', 'personality', 'behavior', 'signals']) {
      assert.match(worker, new RegExp(`await runModule\\(\\s*'${name}'`), name)
    }
    assert.match(worker, /heavyWalletDeferred \|\| scanRpcBudgetExceeded\(moduleErrors\)/)
    assert.match(worker, /if \(!heavyWalletDeferred\) try \{/)
    assert.match(worker, /pnlV2: heavyWalletDeferred \? undefined : pnlOutput\.pnlV2/)
  })
  it('the job runner passes the follow-up flag and attaches the follow-up job', () => {
    assert.match(runner, /\{ heavyWalletFollowUp: payload\.heavyWalletFollowUp === true \}/)
    assert.match(runner, /finalBody = await attachHeavyWalletFollowUp\(finalBody, payload\)/)
  })
  it('the page polls the follow-up, shows "PnL still processing", and keeps the snapshot on failure', () => {
    assert.match(page, /pollWalletScanJob\(followUpJobId, accessToken\)/)
    assert.match(page, /PnL still processing/)
    assert.match(page, /pnlStatus === 'deferred_heavy_wallet' \? 'pending'/)
    const catchBlock = page.slice(page.indexOf("console.error('Scan failed', err)"), page.indexOf("setError(err instanceof Error ? err.message : 'Scan failed — try again later')"))
    assert.ok(catchBlock.length > 0)
    assert.doesNotMatch(catchBlock, /setPartialSnapshot\(null\)/)
    assert.match(page, /scan did not finish/)
  })
})
