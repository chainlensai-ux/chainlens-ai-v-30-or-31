// PERF-SPRINT TASK, DISCLOSED: static source checks for the three changes in this task that a
// pure-function/mock-KV unit test can't reach without the extensive real-pipeline fixture setup
// other src/pipeline/*.test.ts files already own (runWalletScan() itself is 3500+ lines with a
// deep provider/KV/scheduler dependency graph) — same "read the real source, assert on it
// directly" convention already used elsewhere in this codebase for large orchestration files.
// Run directly with:
//   npx tsx --test src/pipeline/scanPerformance.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

describe('repeat-scan cache TTL (perf-sprint: "cache provider history windows for repeat scans (5-10 min TTL)")', () => {
  it('providerFetchWindow and recoveryPolicy both use the 300s (5 min) repeat-scan constant, not their old 30s/45s literals', () => {
    assert.match(src, /const REPEAT_SCAN_HISTORY_CACHE_TTL_SECONDS = 300/, 'the shared TTL constant must exist and be 300s (5 min), inside the requested 5-10 min range')

    // The real write call is providerFetchWindowKvWriter.write(key, r, <ttl>) — this is the one
    // that actually controls how long providerFetchWindow stays cached (the read-side call passes
    // `skipWrite: true`, so ITS ttl argument is inert; the write call's ttl is the real one).
    const writeCallMatch = src.match(/providerFetchWindowKvWriter\.write\(\s*`v2:providerFetchWindow:\$\{r\.chain\}:\$\{params\.walletAddress\.toLowerCase\(\)\}`,\s*r,\s*(\S+)\s*\)/)
    assert.ok(writeCallMatch, 'could not locate the real providerFetchWindow KV write call')
    assert.equal(writeCallMatch[1], 'REPEAT_SCAN_HISTORY_CACHE_TTL_SECONDS', 'the real providerFetchWindow write must use the 5-10min repeat-scan constant, not a hardcoded 30')
    assert.doesNotMatch(src, /providerFetchWindowKvWriter\.write\(\s*`v2:providerFetchWindow[^)]*,\s*30\s*\)/, 'must not regress back to the old hardcoded 30s TTL')

    const recoveryPolicyCallMatch = src.match(/const recoveryPolicy = await withStageCache\(\s*`v2:recoveryPolicy:[^`]*`,\s*(\S+),/)
    assert.ok(recoveryPolicyCallMatch, 'could not locate the recoveryPolicy withStageCache call')
    assert.equal(recoveryPolicyCallMatch[1], 'REPEAT_SCAN_HISTORY_CACHE_TTL_SECONDS', 'recoveryPolicy must use the 5-10min repeat-scan constant, not its old hardcoded 45')
  })

  it('holdings (current balances, not history) is deliberately left untouched at its own short TTL — this task only covers "provider history windows"', () => {
    // runWalletScanV2.ts, not index.ts — holdings freshness is a real product tradeoff (an actively
    // trading wallet's CURRENT balance going stale for 5-10 minutes is a materially different risk
    // than a past block's immutable transfer history being cached longer), deliberately out of
    // scope for this task's "provider history windows" ask.
    const runWalletScanV2Src = readFileSync(fileURLToPath(new URL('./runWalletScanV2.ts', import.meta.url)), 'utf8')
    assert.match(runWalletScanV2Src, /`v2:holdings:\$\{chain\}[^`]*`,\s*20,/, 'holdings cache TTL must remain untouched at 20s — this is current-balance data, not history')
  })
})

describe('router discovery backgrounded (perf-sprint: "move router discovery to a background task")', () => {
  it('the log-only router-discovery candidate loop runs inside setImmediate, off the synchronous response-building path', () => {
    const discoveryBlockMatch = src.match(/\/\/ ROUTER DISCOVERY, DISCLOSED:[\s\S]{0,2500}?recordRouterCandidate\(/)
    assert.ok(discoveryBlockMatch, 'could not locate the router discovery block')
    assert.match(discoveryBlockMatch[0], /setImmediate\(\(\) => \{/, 'router discovery must be deferred via setImmediate, not run inline on the critical path')
  })

  it('nothing in runWalletScan reads recordRouterCandidate\'s return value — deferring it cannot change the final report', () => {
    // recordRouterCandidate returns void in this module's real signature; this assertion instead
    // proves no result is captured from the call (e.g. `const x = recordRouterCandidate(...)`),
    // which is the actual determinism guarantee the setImmediate deferral depends on.
    assert.doesNotMatch(src, /=\s*recordRouterCandidate\(/, 'recordRouterCandidate\'s return value must never be captured/used — otherwise deferring its execution could change downstream behavior')
  })
})

describe('scanPerformanceSummary (perf-sprint: "per-stage timings, percentage of total runtime, critical path, provider latency, cache hit rate, and total scan duration")', () => {
  it('is built from real, already-measured values and attached to the returned report — not a separate fabricated summary', () => {
    assert.match(src, /const scanPerformanceSummary: ScanPerformanceSummary = \{/, 'scanPerformanceSummary must be constructed as a real, typed value')
    assert.match(src, /totalMs: scanTotalMs/, 'totalMs must come from the real measured elapsed time')
    assert.match(src, /stages: stageEntries\.map/, 'per-stage timings must come from scanTimer.stages (the same timer every other stage in this file already marks into), not new instrumentation')
    assert.match(src, /criticalPath: stageEntries\.map\(\(\[name\]\) => name\)/, 'critical path must be derived from the real stage execution order, not a guessed/hardcoded list')
    assert.match(src, /providerLatencyMs: chainLatencies\.map/, 'provider latency must come from the real per-chain chainLatencies array, not new instrumentation')
    assert.match(src, /cacheHitRate: \{/, 'cache hit rate must be present')
    assert.match(src, /scanPerformanceSummary,\s*\n\s*\/\/ GOLDRUSH CALL SPLIT/, 'scanPerformanceSummary must actually be attached to the object this function returns, not just logged')
  })
})
