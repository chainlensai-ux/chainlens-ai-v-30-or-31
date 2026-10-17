// Partial scan → background completion: once the 45s portfolio grace period passes while the job is
// still live, PnL/activity/CORTEX read as processing (never unavailable, skipped or $0), the poll keeps
// running past its soft timeout while the worker heartbeats, and a done result replaces the snapshot.
//   npx tsx --test app/terminal/wallet-scanner/page.partialProcessing.test.ts
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deriveWalletScanStageState } from './page'
import { POLL_HARD_CAP_MS, POLL_TIMEOUT_MS, shouldKeepPollingWalletScan } from '@/app/frontend/api/scanWallet'

const base = { hasPartialSnapshot: true, hasResult: false, pnlStatus: null, chainActivityV2Present: false, hasError: false, timeoutHit: false }

describe('deriveWalletScanStageState — portfolio ready, rest still processing', () => {
  it('past the grace period with the job still live, sections are pending, not unavailable/skipped', () => {
    const s = deriveWalletScanStageState({ ...base, loading: true, limitedEvidenceMode: true })
    assert.equal(s.holdings, 'ready')
    assert.equal(s.portfolio, 'ready')
    assert.equal(s.pnl, 'pending')
    assert.equal(s.activity, 'pending')
    assert.equal(s.cortex, 'pending')
    assert.equal(s.finalStatus, 'portfolio_ready_processing')
  })
  it('only when the job is no longer live do missing sections read as unavailable', () => {
    const s = deriveWalletScanStageState({ ...base, loading: false, limitedEvidenceMode: true })
    assert.equal(s.pnl, 'unavailable')
    assert.equal(s.activity, 'unavailable')
    assert.equal(s.cortex, 'skipped')
    assert.equal(s.finalStatus, 'completed_with_limited_evidence')
  })
  it('a background completion after the partial snapshot flips every section to its real state', () => {
    const s = deriveWalletScanStageState({ ...base, loading: false, limitedEvidenceMode: true, hasResult: true, pnlStatus: 'partial', chainActivityV2Present: true })
    assert.deepEqual([s.pnl, s.activity, s.cortex, s.finalStatus], ['partial', 'ready', 'ready', 'completed'])
  })
  it('a failed PnL/activity/CORTEX never takes the portfolio down with it', () => {
    const s = deriveWalletScanStageState({ ...base, loading: false, limitedEvidenceMode: true, hasError: true, timeoutHit: true })
    assert.equal(s.holdings, 'ready')
    assert.equal(s.portfolio, 'ready')
    assert.equal(s.finalStatus, 'stalled')
  })
  it('heavy-wallet deferred PnL stays pending, never verified zero', () => {
    const s = deriveWalletScanStageState({ ...base, loading: false, limitedEvidenceMode: false, hasResult: true, pnlStatus: 'deferred_heavy_wallet', chainActivityV2Present: true })
    assert.equal(s.pnl, 'pending')
  })
})

describe('partial card copy', () => {
  const source = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8')
  it('the still-processing branch tells the user to wait, not to rescan, and offers no retry', () => {
    const start = source.indexOf(') : stillProcessing ? (')
    assert.ok(start > 0)
    const branch = source.slice(start, source.indexOf(') : ', start + 25))
    assert.match(branch, /appear here automatically/)
    assert.match(branch, /Nothing is shown as \$0/)
    assert.doesNotMatch(branch, /Retry|onClick/)
  })
})

describe('shouldKeepPollingWalletScan', () => {
  it('always polls inside the soft timeout', () => {
    assert.equal(shouldKeepPollingWalletScan({ elapsedMs: 10_000, status: null, lastWorkerUpdateAgoMs: null }), true)
  })
  it('past the soft timeout, keeps polling only a running job with a fresh heartbeat', () => {
    const elapsedMs = POLL_TIMEOUT_MS + 5_000
    assert.equal(shouldKeepPollingWalletScan({ elapsedMs, status: 'running', lastWorkerUpdateAgoMs: 10_000 }), true)
    assert.equal(shouldKeepPollingWalletScan({ elapsedMs, status: 'running', lastWorkerUpdateAgoMs: 60_000 }), false)
    assert.equal(shouldKeepPollingWalletScan({ elapsedMs, status: 'queued', lastWorkerUpdateAgoMs: 1_000 }), false)
    assert.equal(shouldKeepPollingWalletScan({ elapsedMs, status: 'running', lastWorkerUpdateAgoMs: null }), false)
  })
  it('never past the hard cap', () => {
    assert.equal(shouldKeepPollingWalletScan({ elapsedMs: POLL_HARD_CAP_MS, status: 'running', lastWorkerUpdateAgoMs: 0 }), false)
  })
})

describe('pollWalletScanJob — partial then background completion', () => {
  const originalSetTimeout = global.setTimeout
  it('survives a dropped poll and a 503, carries the partial snapshot, then returns the full result', async () => {
    global.setTimeout = ((cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0)) as typeof setTimeout
    const originalFetch = global.fetch
    const updates: Array<{ status: string; partial?: unknown }> = []
    let n = 0
    global.fetch = mock.fn(async () => {
      n += 1
      if (n === 1) return new Response(JSON.stringify({ status: 'running', partial: { holdings: 101 }, serverNow: 10, heartbeatAt: 5 }), { status: 200 })
      if (n === 2) throw new TypeError('network dropped')
      if (n === 3) return new Response(JSON.stringify({ error: 'scan-status-unavailable' }), { status: 503 })
      return new Response(JSON.stringify({ status: 'done', result: { success: true, data: { full: true } } }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const { pollWalletScanJob } = await import('@/app/frontend/api/scanWallet')
      const result = await pollWalletScanJob('job-p', 'token', (u) => updates.push(u))
      assert.equal(result.success, true)
      assert.deepEqual((result as { data?: unknown }).data, { full: true })
      assert.deepEqual(updates[0].partial, { holdings: 101 })
      assert.equal(updates.at(-1)?.status, 'done')
      assert.equal(n, 4)
    } finally {
      global.fetch = originalFetch
      global.setTimeout = originalSetTimeout
    }
  })
})

describe('pollWalletScanJob — a joined job that never appears', () => {
  const originalSetTimeout = global.setTimeout
  it('gives up after 30s of not-found instead of polling a missing job for minutes', async () => {
    global.setTimeout = ((cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0)) as typeof setTimeout
    const originalFetch = global.fetch
    const originalNow = Date.now
    let clock = 1_000_000
    Date.now = () => clock
    let polls = 0
    global.fetch = mock.fn(async () => { polls += 1; clock += 5_000; return new Response(JSON.stringify({ status: 'not-found' }), { status: 404 }) }) as unknown as typeof fetch
    try {
      const { pollWalletScanJob, POLL_NEVER_FOUND_GIVE_UP_MS } = await import('@/app/frontend/api/scanWallet')
      const result = await pollWalletScanJob('ghost', 'token')
      assert.equal(result.success, false)
      assert.match(result.error?.message ?? '', /could not be started/)
      assert.equal(polls, POLL_NEVER_FOUND_GIVE_UP_MS / 5_000)
    } finally {
      global.fetch = originalFetch
      global.setTimeout = originalSetTimeout
      Date.now = originalNow
    }
  })
})
