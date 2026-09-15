// Static source checks for the Wallet Scanner unexplained-latency audit.
//
// WHY STATIC: `runWalletScan` is a ~4,500-line orchestration function over a dozen protected
// modules with real provider/KV dependencies — this repo's established convention for defending its
// wiring is a source-level assertion (see scanPerformance.staticCheck.test.ts,
// ingestionSerialization.staticCheck.test.ts). These checks defend two things a runtime test here
// could not: that every previously-unmeasured critical-path region is now instrumented, and that
// the one behavioral change (Aerodrome pool-discovery pre-warm) provably performs the SAME work as
// the serial version it replaced.
//
// Run directly with: npx tsx --test src/pipeline/walletScanLatencyInstrumentation.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pipeline = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const v2 = readFileSync(new URL('./runWalletScanV2.ts', import.meta.url), 'utf8')
const metadata = readFileSync(new URL('./metadata.ts', import.meta.url), 'utf8')

describe('wallet scan latency instrumentation — previously unmeasured regions are now measured', () => {
  it('instruments every post-pricingAtTime region the legacy scanTimer structurally could not see', () => {
    for (const stageName of [
      'aerodromePoolDiscoveryPrewarm',
      'syntheticPoolPricing',
      'boundaryDependentSellResolution',
      'canonicalSampleSelection',
      'pnlReconciliation',
      'roiQuoteLegProofPersistence',
      'providerWindowKvWriteSettle',
    ]) {
      // Whitespace-tolerant: several of these call sites wrap the stage name onto its own line.
      assert.match(
        pipeline,
        new RegExp(`stageProfiler\\.stage\\(\\s*'${stageName}'`),
        `post-pricingAtTime region '${stageName}' must be wrapped in a profiler stage`,
      )
    }
  })

  it('instruments the outer job stages that run outside runWalletScan entirely', () => {
    for (const stageName of ['holdingsFetch', 'currentPriceResolution', 'runWalletScan']) {
      assert.ok(
        v2.includes(`outerProfiler.stage('${stageName}'`),
        `outer job region '${stageName}' must be wrapped in a profiler stage`,
      )
    }
    assert.ok(v2.includes("outerProfiler.stageSync('portfolioSummary'"), 'portfolio assembly must be measured')
  })

  it('folds the seven legacy scanTimer stages into the same reconciliation instead of leaving two disjoint views', () => {
    assert.match(pipeline, /for \(const \[name, ms\] of stageEntries\) \{\s*\n\s*stageProfiler\.record\(/,
      'legacy scanTimer stages must be recorded into the profiler so one reconciliation covers the whole scan')
    assert.ok(pipeline.includes('const scanStageProfile = stageProfiler.build({ totalMs: scanTotalMs })'))
    assert.ok(pipeline.includes("console.warn('[wallet-scan-stage-profile]'"), 'the profile must be emitted for production diagnosis')
    assert.ok(v2.includes("console.warn('[wallet-scan-job-stage-profile]'"), 'the job-level reconciliation must be emitted')
  })

  it('creates a fresh profiler per scan — never a module-level singleton two concurrent scans could share', () => {
    assert.match(pipeline, /const stageProfiler = createScanStageProfiler\(\)/)
    assert.match(v2, /const outerProfiler = createScanStageProfiler\(\)/)
    // A module-scope `const ... = createScanStageProfiler()` (column 0) would be shared across
    // concurrent requests in a warm serverless instance.
    assert.doesNotMatch(pipeline, /^const \w+ = createScanStageProfiler\(\)/m)
    assert.doesNotMatch(v2, /^const \w+ = createScanStageProfiler\(\)/m)
  })

  it('reports the unexplained residue explicitly rather than absorbing it', () => {
    const profiler = readFileSync(new URL('./scanStageProfiler.ts', import.meta.url), 'utf8')
    assert.ok(profiler.includes('unexplainedMs'))
    assert.ok(profiler.includes('unexplainedPercent'))
    assert.ok(profiler.includes('withinTolerance'))
    // Nested stages must be excluded from the sum, or a parent's time would be counted twice.
    assert.ok(profiler.includes("samples.filter((s) => s.depth === 0)"))
  })
})

describe('Aerodrome pool-discovery pre-warm — the one behavioral change', () => {
  it('starts the independent discoveries up front with bounded concurrency 8', () => {
    assert.ok(pipeline.includes('const AERODROME_DISCOVERY_CONCURRENCY = 8'))
    assert.match(pipeline, /Math\.min\(AERODROME_DISCOVERY_CONCURRENCY, baseTokensToPrewarm\.length\)/)
  })

  it('pre-warms exactly the distinct Base tokens of the SAME two entry lists the serial loop walks', () => {
    assert.match(
      pipeline,
      /const baseTokensToPrewarm = \[\.\.\.new Set\(\s*\n\s*\[\.\.\.displayBuyEntries, \.\.\.sellTimelineV2\.entries\]\s*\n\s*\.filter\(\(entry\) => entry\.chain === 'base'\)\s*\n\s*\.map\(\(entry\) => entry\.token\.toLowerCase\(\)\),\s*\n\s*\)\]/,
      'the pre-warm set must be the deduped Base tokens of the exact same two entry lists, so the call count is unchanged',
    )
    // Both recordSyntheticPoolPrice call sites still process those same two lists.
    assert.ok(pipeline.includes('await recordSyntheticPoolPrice(displayBuyEntries, pricingAtTime.costUsd)'))
    assert.ok(pipeline.includes('await recordSyntheticPoolPrice(sellTimelineV2.entries, pricingAtTime.proceedsUsd)'))
  })

  it('populates the SAME memo the loop reads, and the loop\'s own lazy-discovery path is untouched', () => {
    assert.ok(pipeline.includes('aerodromeDiscovery.set(token, discovery)'), 'pre-warm must fill the same promise memo')
    // The loop still owns its original lazy path — a token not pre-warmed still discovers normally.
    assert.match(pipeline, /let discovery = aerodromeDiscovery\.get\(entry\.token\.toLowerCase\(\)\)/)
    assert.match(pipeline, /discovery = discoverAerodromePools\(entry\.token\)/)
    assert.match(pipeline, /aerodromePool = mapAerodromeToken\(token, await discovery\)/)
    // Dedup by chain:token is unchanged, so no token is discovered more than once.
    assert.ok(pipeline.includes('if (key in syntheticPoolData) continue'))
  })

  it('skips a token already memoized, so pre-warm can never add a duplicate provider call', () => {
    assert.ok(pipeline.includes('if (aerodromeDiscovery.has(token)) continue'))
  })

  it('preserves failure semantics: the stored promise carries its own rejection to the awaiting loop', () => {
    // The pre-warm must store the raw promise (not a caught/normalized one) so the loop observes the
    // identical resolution or rejection it would have observed had it started the call itself.
    assert.match(pipeline, /const discovery = discoverAerodromePools\(token\)\s*\n\s*aerodromeDiscovery\.set\(token, discovery\)/)
    assert.ok(pipeline.includes('await discovery.catch(() => undefined)'), 'settling must not abort the other pre-warms')
  })

  it('is provably case-equivalent: query() lowercases the token before it reaches the subgraph', () => {
    // The loop passes original-cased `entry.token`; the pre-warm passes the lowercased form. This is
    // only safe because the transport lowercases it itself — assert that, so a future change to
    // metadata.ts that made case significant would fail here instead of silently changing requests.
    assert.match(metadata, /variables: \{ token: token\.toLowerCase\(\) \}/)
  })
})
