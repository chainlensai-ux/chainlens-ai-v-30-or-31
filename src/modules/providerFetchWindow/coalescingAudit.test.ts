// Tests for src/modules/providerFetchWindow/index.ts's per-key coalescing audit and the
// never-rejects hardening.
//
// BEHAVIOR REVISED, DISCLOSED (Alchemy-history-ingestion-regression task — confirmed production
// root cause: GoldRush genuinely succeeded, Alchemy was refused by the shared per-job CU budget —
// a transient, request-scoped throttle, never a real provider outage — yet the merged, Alchemy-less
// result was memoized as "settled success" and reused by every later duplicate caller for the rest
// of the job, collapsing ~565 events / ~216 lots to 89 events / 45 lots). This file previously
// asserted the OPPOSITE of what's now required: this task's own explicit instruction is "never
// permanently cache: null, timeout, HTTP failure, malformed response, budget refusal" and "only
// successful settled results may enter settled-result reuse." A TRANSIENT failure (timeout, thrown
// error, budget refusal, malformed response) is now EVICTED from the coalescing map the instant it
// settles — see index.ts's own isReuseEligible/isPermanentFailureReason — so a caller arriving
// AFTER that resolution gets a genuinely fresh live attempt instead of being stuck with one unlucky
// throttle for the rest of the job. A caller already concurrently awaiting the SAME in-flight
// promise still receives that result (real coalescing of genuinely simultaneous work is
// unaffected) — eviction only changes what a LATER, non-concurrent caller receives. Only a
// PERMANENT failure (missing API key, unsupported chain — see PERMANENT_FAILURE_REASONS) is still
// memoized for the rest of the job, since retrying it can never succeed. Mocks global.fetch (no
// real network dependency), same pattern as coalescing.test.ts. Run with:
//   npx tsx --test src/modules/providerFetchWindow/coalescingAudit.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchProviderWindow,
  resetProviderFetchWindowRequestCache,
  getProviderFetchWindowKeyAudits,
  classifyFetchOutcome,
} from './index'
import type { ProviderFetchWindowResult } from './types'

const originalFetch = global.fetch
const originalGoldrushKey = process.env.GOLDRUSH_API_KEY
const originalAlchemyBaseKey = process.env.ALCHEMY_BASE_KEY
const originalAlchemyEthKey = process.env.ALCHEMY_ETHEREUM_KEY

beforeEach(() => {
  resetProviderFetchWindowRequestCache('test-job-1')
  process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
  process.env.ALCHEMY_BASE_KEY = 'test-alchemy-key'
  process.env.ALCHEMY_ETHEREUM_KEY = 'test-alchemy-key'
})

afterEach(() => {
  global.fetch = originalFetch
  resetProviderFetchWindowRequestCache()
  process.env.GOLDRUSH_API_KEY = originalGoldrushKey
  process.env.ALCHEMY_BASE_KEY = originalAlchemyBaseKey
  process.env.ALCHEMY_ETHEREUM_KEY = originalAlchemyEthKey
})

function mockFetch(opts: { delayMs?: number; abort?: boolean; fail?: boolean; ok?: boolean } = {}): { getCallCount: () => number } {
  let callCount = 0
  global.fetch = (async (url: string, init?: { signal?: AbortSignal }) => {
    callCount += 1
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
    if (opts.abort) {
      // Mirrors a REAL AbortSignal.timeout firing — the exact production scenario (a 12s Covalent
      // timeout) this task investigates, distinct from a generic thrown Error.
      const reason = init?.signal?.reason
      throw reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'TimeoutError')
    }
    if (opts.fail) throw new Error('simulated provider failure')
    if (opts.ok === false) return new Response('', { status: 500 })
    // URL-aware success shapes, DISCLOSED: goldrush (covalenthq.com) and alchemy (g.alchemy.com)
    // expect genuinely different real response shapes — a one-size body would make Alchemy's own
    // `rpc()` helper see no `.result` field and honestly report a miss, producing 'partial' instead
    // of the real 'ok' this test needs to model an actual full success.
    const body = typeof url === 'string' && url.includes('g.alchemy.com')
      ? { result: { transfers: [] } }
      : { data: { items: [] } }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { getCallCount: () => callCount }
}

describe('fetchProviderWindow — per-key audit fields (1: two concurrent identical calls -> one live fetch)', () => {
  it('two concurrent identical calls produce exactly one live fetch and one coalesced (pending) reuse', async () => {
    const { getCallCount } = mockFetch({ delayMs: 20 })
    await Promise.all([
      fetchProviderWindow('base', '0xwallet', 90),
      fetchProviderWindow('base', '0xwallet', 90),
    ])
    assert.equal(getCallCount(), 3, 'exactly one real goldrush + one real (2-batch) alchemy call, not two of each')
    const audits = getProviderFetchWindowKeyAudits()
    const baseAudit = audits.find((a) => a.key === 'base:0xwallet')
    assert.equal(baseAudit?.liveFetches, 1)
    assert.equal(baseAudit?.pendingCoalescedHits, 1, 'the second concurrent caller must be recorded as a pending coalesced hit')
    assert.equal(baseAudit?.duplicateLiveFetchPrevented, 1)
    assert.equal(baseAudit?.invocationCount, 2)
  })
})

describe('fetchProviderWindow — (2) successful later duplicate produces no new live fetch', () => {
  it('a caller arriving after a SUCCESSFUL settle reuses the result, recorded as a settled SUCCESS reuse', async () => {
    const { getCallCount } = mockFetch({})
    const first = await fetchProviderWindow('base', '0xwallet', 90, 'old-pipeline')
    assert.equal(first.providerStatus, 'ok')
    const callsAfterFirst = getCallCount()

    const second = await fetchProviderWindow('base', '0xwallet', 90, 'v2-engine')
    assert.equal(getCallCount(), callsAfterFirst, 'no new live fetch for a successful later duplicate')
    assert.deepEqual(second, first)

    const audit = getProviderFetchWindowKeyAudits().find((a) => a.key === 'base:0xwallet')
    assert.equal(audit?.firstOutcome, 'success')
    assert.equal(audit?.settledSuccessReuseHits, 1)
    assert.equal(audit?.settledFailureReuseHits, 0)
  })
})

describe('fetchProviderWindow — (3) timed-out later duplicate gets a fresh retry (transient failure, never permanently cached)', () => {
  it('a caller arriving after a REAL AbortSignal-timeout-shaped failure triggers its own fresh live attempt, never reusing the stale failure', async () => {
    const { getCallCount } = mockFetch({ abort: true })
    const first = await fetchProviderWindow('base', '0xwallet', 90, 'old-pipeline')
    assert.equal(first.providerStatus, 'provider_unavailable')
    const callsAfterFirst = getCallCount()
    assert.ok(callsAfterFirst > 0)

    const second = await fetchProviderWindow('base', '0xwallet', 90, 'v2-engine')
    assert.ok(getCallCount() > callsAfterFirst, 'a timed-out (transient) later duplicate must get a genuinely fresh attempt, never be stuck with the stale failure')
    assert.equal(second.providerStatus, 'provider_unavailable')

    // The evicted key's audit no longer exists as ONE historical entry — it was replaced by the
    // fresh attempt's own new entry, itself also evicted after settling (still failing, since the
    // mock still simulates a timeout on every call).
    const audit = getProviderFetchWindowKeyAudits().find((a) => a.key === 'base:0xwallet')
    assert.equal(audit, undefined, 'a transiently-failed entry must not remain in the map after settling')
  })
})

describe('fetchProviderWindow — (4) a generically-failed later duplicate also gets a fresh retry (transient failure)', () => {
  it('a thrown, caught provider error is a transient failure — a later duplicate gets its own fresh live attempt', async () => {
    const { getCallCount } = mockFetch({ fail: true })
    const first = await fetchProviderWindow('base', '0xwallet', 90)
    const callsAfterFirst = getCallCount()
    assert.equal(first.providerStatus, 'provider_unavailable')

    const second = await fetchProviderWindow('base', '0xwallet', 90)
    assert.ok(getCallCount() > callsAfterFirst, 'a generic thrown-and-caught provider failure must also be treated as transient, never permanently cached')
    assert.equal(second.providerStatus, 'provider_unavailable')
  })

  it('concurrent (genuinely simultaneous) callers still coalesce onto one real in-flight fetch, even though the outcome is transient', async () => {
    const { getCallCount } = mockFetch({ fail: true, delayMs: 10 })
    const [a, b] = await Promise.all([
      fetchProviderWindow('base', '0xwallet', 90),
      fetchProviderWindow('base', '0xwallet', 90),
    ])
    assert.equal(getCallCount(), 3, 'two genuinely concurrent callers must still share ONE real in-flight fetch')
    assert.deepEqual(a, b, 'concurrent callers receive the identical in-flight result, regardless of eviction afterward')
  })
})

describe('fetchProviderWindow — (5) degraded result retains the original timeout/error reason', () => {
  it('the errorReason from the first, real failed attempt is preserved across every later reuse', async () => {
    mockFetch({ abort: true })
    const first = await fetchProviderWindow('base', '0xwallet', 90)
    const originalReason = first.providerResults.goldrush.errorReason
    assert.ok(originalReason, 'sanity: the first attempt must carry a real, non-null error reason')

    const second = await fetchProviderWindow('base', '0xwallet', 90)
    assert.equal(second.providerResults.goldrush.errorReason, originalReason, 'the ORIGINAL failure reason must be preserved, never replaced or genericized on reuse')
  })
})

describe('fetchProviderWindow — (6) Base failure does not affect Ethereum', () => {
  it('a Base timeout leaves Ethereum entirely independent — its own live fetch still succeeds', async () => {
    mockFetch({ abort: true })
    const base = await fetchProviderWindow('base', '0xwallet', 90)
    assert.equal(base.providerStatus, 'provider_unavailable')

    mockFetch({}) // Ethereum's own real call succeeds
    const eth = await fetchProviderWindow('eth', '0xwallet', 90)
    assert.equal(eth.providerStatus, 'ok', 'a Base failure must never suppress or degrade a different chain\'s own independent fetch')

    // Base's transient failure was evicted (see describe block 3 above); Ethereum's real success
    // remains settled and audited normally — proves eviction is per-key, never global.
    const audits = getProviderFetchWindowKeyAudits()
    assert.equal(audits.find((a) => a.key === 'base:0xwallet'), undefined, 'Base\'s transient failure must not remain in the map')
    assert.equal(audits.find((a) => a.key === 'eth:0xwallet')?.firstOutcome, 'success')
  })
})

describe('fetchProviderWindow — (7) a new job reset permits a new Base attempt', () => {
  it('resetProviderFetchWindowRequestCache clears the map — the next job may attempt Base again', async () => {
    const { getCallCount } = mockFetch({ abort: true })
    await fetchProviderWindow('base', '0xwallet', 90)
    const callsAfterFirstJob = getCallCount()
    // The transient failure was already evicted within THIS job (see describe block 3 above) —
    // the map is already empty for this key before the reset even runs.
    assert.equal(getProviderFetchWindowKeyAudits().length, 0)

    resetProviderFetchWindowRequestCache('test-job-2')
    assert.equal(getProviderFetchWindowKeyAudits().length, 0, 'a fresh job must start with no carried-over key audits')

    await fetchProviderWindow('base', '0xwallet', 90)
    assert.ok(getCallCount() > callsAfterFirstJob, 'a new job must be free to attempt Base again, not be permanently blocked by the previous job\'s failure')
  })
})

describe('fetchProviderWindow — (8) old-pipeline and V2-engine share the same request-scoped entry', () => {
  it('an "old-pipeline" caller and a later "v2-engine" caller for the identical key share one live fetch', async () => {
    const { getCallCount } = mockFetch({})
    const oldPipelineResult = await fetchProviderWindow('base', '0xwallet', 90, 'old-pipeline')
    const callsAfterOldPipeline = getCallCount()

    const v2EngineResult = await fetchProviderWindow('base', '0xwallet', 90, 'v2-engine')
    assert.equal(getCallCount(), callsAfterOldPipeline, 'the v2-engine stage must reuse old-pipeline\'s already-settled result, never re-fetch')
    assert.deepEqual(v2EngineResult, oldPipelineResult)
  })

  it('when the FIRST (old-pipeline) attempt timed out, v2-engine gets its own fresh retry rather than reusing the stale failure', async () => {
    const { getCallCount } = mockFetch({ abort: true })
    await fetchProviderWindow('base', '0xwallet', 90, 'old-pipeline')
    const callsAfterOldPipeline = getCallCount()

    await fetchProviderWindow('base', '0xwallet', 90, 'v2-engine')
    assert.ok(getCallCount() > callsAfterOldPipeline, 'v2-engine must get a genuinely fresh attempt after old-pipeline\'s transient (timeout) failure, never be stuck reusing it')
  })
})

describe('fetchProviderWindow — (9) no provider-call budgets or window sizes change', () => {
  it('goldrush + alchemy(2-batch) = exactly 3 real fetch() calls for one live fetch, unchanged', async () => {
    const { getCallCount } = mockFetch({})
    await fetchProviderWindow('base', '0xwallet', 90)
    assert.equal(getCallCount(), 3)
  })

  it('the requested 90-day window is unchanged and unclamped for the default case', async () => {
    mockFetch({})
    const result = await fetchProviderWindow('base', '0xwallet', 90)
    assert.equal(result.providerFetchWindowDays, 90)
  })
})

describe('classifyFetchOutcome — pure, exported for direct testing', () => {
  function fixture(overrides: Partial<ProviderFetchWindowResult> = {}): ProviderFetchWindowResult {
    return {
      chain: 'base',
      providerStatus: 'ok',
      rawEvents: [],
      providerResults: {
        goldrush: { provider: 'goldrush', ok: true, events: [], errorReason: null },
        alchemy: { provider: 'alchemy', ok: true, events: [], errorReason: null },
      },
      providerFetchWindowDays: 90,
      ...overrides,
    }
  }

  it('classifies "ok" and "partial" as success', () => {
    assert.equal(classifyFetchOutcome(fixture({ providerStatus: 'ok' })), 'success')
    assert.equal(classifyFetchOutcome(fixture({ providerStatus: 'partial' })), 'success')
  })

  it('classifies a timeout/abort-shaped errorReason as "timeout"', () => {
    const result = fixture({
      providerStatus: 'provider_unavailable',
      providerResults: {
        goldrush: { provider: 'goldrush', ok: false, events: [], errorReason: 'The operation was aborted due to timeout' },
        alchemy: { provider: 'alchemy', ok: false, events: [], errorReason: null },
      },
    })
    assert.equal(classifyFetchOutcome(result), 'timeout')
  })

  it('classifies any other both-failed reason as "error"', () => {
    const result = fixture({
      providerStatus: 'provider_unavailable',
      providerResults: {
        goldrush: { provider: 'goldrush', ok: false, events: [], errorReason: 'http_500' },
        alchemy: { provider: 'alchemy', ok: false, events: [], errorReason: 'no_api_key_configured' },
      },
    })
    assert.equal(classifyFetchOutcome(result), 'error')
  })
})
