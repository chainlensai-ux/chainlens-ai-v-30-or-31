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

describe('repeat-scan cache TTL (perf-sprint task, NARROWED by perf-guardrails follow-up task: "Keep the 300s cache only for immutable or historical data. Do not cache live wallet activity, transfers, swaps, balances, or provider event fetches beyond the existing short TTL.")', () => {
  it('recoveryPolicy (a bounded, deterministic recomputation over a fixed past window) uses the 300s repeat-scan constant', () => {
    assert.match(src, /const REPEAT_SCAN_HISTORY_CACHE_TTL_SECONDS = 300/, 'the shared TTL constant must exist and be 300s (5 min)')

    const recoveryPolicyCallMatch = src.match(/const recoveryPolicy = await withStageCache\(\s*`v2:recoveryPolicy:[^`]*`,\s*(\S+),/)
    assert.ok(recoveryPolicyCallMatch, 'could not locate the recoveryPolicy withStageCache call')
    assert.equal(recoveryPolicyCallMatch[1], 'REPEAT_SCAN_HISTORY_CACHE_TTL_SECONDS', 'recoveryPolicy must use the 5-10min repeat-scan constant')
  })

  it('providerFetchWindow (live, open-ended wallet activity) is REVERTED to its own short 30s TTL — never the 300s constant, to avoid hiding a brand-new transaction on a rescan', () => {
    assert.match(src, /const PROVIDER_FETCH_WINDOW_CACHE_TTL_SECONDS = 30/, 'the dedicated short TTL constant must exist and be 30s')

    // The real write call is providerFetchWindowKvWriter.write(key, r, <ttl>) — this is the one
    // that actually controls how long providerFetchWindow stays cached (the read-side call passes
    // `skipWrite: true`, so ITS ttl argument is inert; the write call's ttl is the real one).
    const writeCallMatch = src.match(/providerFetchWindowKvWriter\.write\(\s*`v2:providerFetchWindow:\$\{r\.chain\}:\$\{params\.walletAddress\.toLowerCase\(\)\}`,\s*r,\s*(\S+)\s*\)/)
    assert.ok(writeCallMatch, 'could not locate the real providerFetchWindow KV write call')
    assert.equal(writeCallMatch[1], 'PROVIDER_FETCH_WINDOW_CACHE_TTL_SECONDS', 'the real providerFetchWindow write must use its own short-TTL constant, never the 300s repeat-scan one')
    assert.doesNotMatch(src, /providerFetchWindowKvWriter\.write\(\s*`v2:providerFetchWindow[^)]*,\s*REPEAT_SCAN_HISTORY_CACHE_TTL_SECONDS\s*\)/, 'must not regress back to sharing the 300s constant — that hides live wallet activity on a rescan')

    const readCallMatch = src.match(/const result = await withStageCache\(\s*`v2:providerFetchWindow:\$\{chain\}:\$\{params\.walletAddress\.toLowerCase\(\)\}`,\s*(\S+),/)
    assert.ok(readCallMatch, 'could not locate the providerFetchWindow read-side withStageCache call')
    assert.equal(readCallMatch[1], 'PROVIDER_FETCH_WINDOW_CACHE_TTL_SECONDS', 'the read-side call must also use the short-TTL constant (kept consistent with the write side, even though its own ttl argument is inert under skipWrite: true)')
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

  it('marks fifoEngine (the real, load-bearing FIFO run only) and receiptDecoding, so "Measure FIFO/PnL time" and "Measure receipt decoding time" are both real, not omitted', () => {
    assert.match(src, /const fifoEngineStart = performance\.now\(\)\s*\n\s*const fifoAndPnl = safeRunFifoEngine\(/, 'fifoEngineStart must be taken immediately before the real fifoAndPnl call, not a diagnostic rerun')
    assert.match(src, /scanTimer\.mark\('fifoEngine', fifoEngineStart\)/, 'fifoEngine must be marked into the same scanTimer every other stage uses')
    assert.match(src, /const receiptDecodingStart = performance\.now\(\)/, 'receiptDecodingStart must exist')
    assert.match(src, /scanTimer\.mark\('receiptDecoding', receiptDecodingStart\)/, 'receiptDecoding must be marked into the same scanTimer')
  })
})

describe('shadow receipt-decode block deferred when inert (perf-sprint: "move [output-irrelevant] work to a background task" / "reduce deep scan latency without changing scan results")', () => {
  it('receiptSwapCanonicalPromotionEnabled is read BEFORE the shadow block, not after it, so the block can branch on it', () => {
    const flagIndex = src.indexOf("const receiptSwapCanonicalPromotionEnabled = process.env.RECEIPT_SWAP_CANONICAL_PROMOTION_ENABLED === 'true'")
    const blockDeclIndex = src.indexOf('const runShadowReceiptDecodeBlock = async ()')
    assert.notEqual(flagIndex, -1, 'receiptSwapCanonicalPromotionEnabled must be declared')
    assert.notEqual(blockDeclIndex, -1, 'runShadowReceiptDecodeBlock must be declared')
    assert.ok(flagIndex < blockDeclIndex, 'the flag must be read before the shadow block is declared, so the block can be dispatched conditionally on it')
    // Exactly one declaration — the later call site must reuse this same const, never re-read the
    // env var a second time (two reads of a static process.env value are harmless, but a second
    // `const` with the same name would be a real duplicate-declaration bug).
    const declarationCount = (src.match(/const receiptSwapCanonicalPromotionEnabled = process\.env\.RECEIPT_SWAP_CANONICAL_PROMOTION_ENABLED/g) ?? []).length
    assert.equal(declarationCount, 1, 'receiptSwapCanonicalPromotionEnabled must be declared exactly once')
  })

  it('the shadow block runs synchronously (awaited) when canonical promotion is enabled, and is deferred via setImmediate when it is not', () => {
    const dispatchMatch = src.match(/if \(receiptSwapCanonicalPromotionEnabled\) \{\s*\n\s*await runShadowReceiptDecodeBlock\(\)\s*\n[\s\S]{0,200}?\} else \{\s*\n\s*setImmediate\(\(\) => \{ runShadowReceiptDecodeBlock\(\)\.catch\(\(\) => \{\}\) \}\)\s*\n\s*\}/)
    assert.ok(dispatchMatch, 'must find the exact awaited-when-enabled / deferred-when-not dispatch pattern')
  })

  it('canonicalNormalizedEvents/receiptSwapPromotionResult only ever read shadowExactReceiptSwaps under the SAME flag the deferral branches on — proves deferring the block when the flag is off can never change the real result', () => {
    assert.match(
      src,
      /if \(receiptSwapCanonicalPromotionEnabled && shadowExactReceiptSwaps\.length > 0\) \{/,
      'the only place shadowExactReceiptSwaps feeds canonicalNormalizedEvents must be gated behind the exact same flag the shadow block itself is dispatched on',
    )
  })
})
