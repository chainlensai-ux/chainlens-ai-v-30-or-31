// PERF-SPRINT TASK, DISCLOSED (history-ingestion serialization audit): static source checks for the
// two reorderings this task made — same "read the real source, assert on it directly" convention as
// scanPerformance.staticCheck.test.ts, for the same reason (runWalletScan() is 3500+ lines with a
// deep provider/KV/scheduler dependency graph a quick fixture-based test can't reach). Both changes
// are pure reordering — same promise, same eventual await, same result — so these tests assert on
// MECHANISM (the promise is created before, awaited later, at the real point of first use), not on
// scan output, which the existing src/pipeline/*.test.ts family already covers unchanged.
// Run directly with:
//   npx tsx --test src/pipeline/ingestionSerialization.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

describe('providerFetchWindow KV write overlaps with unrelated CPU work (perf-sprint: "find every await ... that can safely overlap CPU work with provider/network I/O")', () => {
  it('the write promise is created but NOT awaited at its original call site', () => {
    assert.match(src, /const providerFetchWindowKvWriteSettled = Promise\.all\(/, 'the write must be kicked off into a named promise, not awaited inline')
    assert.doesNotMatch(src, /await Promise\.all\(\s*\n\s*providerResults\.filter/, 'must not regress back to awaiting the write inline before normalization')
  })

  it('is awaited exactly once, before scanTotalMs is measured (so the reported total honestly includes any residual wait)', () => {
    const awaitIndex = src.indexOf('await providerFetchWindowKvWriteSettled')
    const scanTotalMsIndex = src.indexOf('const scanTotalMs = Math.round(performance.now() - scanStartedAtMs)')
    assert.notEqual(awaitIndex, -1, 'must be awaited somewhere')
    assert.notEqual(scanTotalMsIndex, -1, 'scanTotalMs computation must exist')
    assert.ok(awaitIndex < scanTotalMsIndex, 'must be awaited BEFORE scanTotalMs is measured, not after — otherwise the reported total would silently undercount any residual wait')
  })

  it('the CPU work it now overlaps with (allRawEvents/normalizeEvents) reads only from providerResults — never from the write\'s own result', () => {
    // The write promise's declaration must appear BEFORE `const allRawEvents = providerResults...`
    // in the source (proving normalizeEvents no longer waits on it), and normalizeEvents' own real
    // input must still be providerResults, unchanged.
    const writeDeclIndex = src.indexOf('const providerFetchWindowKvWriteSettled = Promise.all(')
    const allRawEventsIndex = src.indexOf('const allRawEvents = providerResults.flatMap((r) => r.rawEvents)')
    assert.notEqual(allRawEventsIndex, -1)
    assert.ok(writeDeclIndex < allRawEventsIndex, 'the write must be kicked off before normalization starts, so they run concurrently')
  })
})

describe('dust-suppression network call overlaps with unrelated CPU work (perf-sprint: same task)', () => {
  it('the dust-suppression promise is created but NOT awaited at its original call site', () => {
    assert.match(src, /const dustSuppressionPromise = resolveDustSuppressionKeys\(timelines\.buyTimeline\.entries, sellTimelineV2\.entries\)/, 'the call must be kicked off into a named promise, not awaited inline')
    assert.doesNotMatch(src, /await resolveDustSuppressionKeys\(/, 'must not regress back to awaiting it inline before the recovered-events CPU work')
  })

  it('is awaited exactly once, at the real point dustSuppressedKeys is first consumed', () => {
    const awaitMatch = src.match(/const \{ suppressedKeys: dustSuppressedKeys, noMarketFoundCount, liquidityZeroCount \} = await dustSuppressionPromise/)
    assert.ok(awaitMatch, 'must destructure the awaited result with the same real field names as before')
    const awaitIndex = awaitMatch.index!
    const firstUseIndex = src.indexOf('const normalizedEventsForPricing = buildFilteredEventsForPricing(canonicalNormalizedEvents, dustSuppressedKeys)')
    assert.notEqual(firstUseIndex, -1)
    assert.ok(awaitIndex < firstUseIndex, 'must be awaited before the first real use of dustSuppressedKeys')
    // Nothing else between the promise's creation and this await point may reference
    // dustSuppressedKeys/noMarketFoundCount/liquidityZeroCount — if it did, the reorder would be
    // unsafe. Slice the exact window and assert it's clean.
    const declIndex = src.indexOf('const dustSuppressionPromise = resolveDustSuppressionKeys(')
    const between = src.slice(declIndex, awaitIndex)
    assert.doesNotMatch(between, /dustSuppressedKeys|noMarketFoundCount|liquidityZeroCount/, 'no code between kicking off the promise and awaiting it may reference its result — that would make the reorder unsafe')
  })

  it('the CPU work it now overlaps with (recoveredRawEventsForPricing/receipt promotion) reads only from recoveryPolicy.evaluation and normalizedEvents/shadowExactReceiptSwaps — already computed earlier', () => {
    const declIndex = src.indexOf('const dustSuppressionPromise = resolveDustSuppressionKeys(')
    const recoveredIndex = src.indexOf('const recoveredRawEventsForPricing = recoveryPolicy.evaluation.flatMap((e) => e.recoveredEvents)')
    assert.notEqual(recoveredIndex, -1)
    assert.ok(declIndex < recoveredIndex, 'the dust-suppression call must be kicked off before the recovered-events CPU work runs, so they run concurrently')
  })
})
