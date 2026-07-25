// Structural (source-scan) tests for app/terminal/wallet-scanner/page.tsx's scan-result lifecycle —
// the confirmed live-value staleness fix. Same pure-source-scan convention this codebase already
// uses for guards that a rendering harness can't express (see
// lib/engine/modules/pricing/fetchPricing.test.ts's "never imports pricingAtTimeEngine" guard and
// app/frontend/components/WalletScannerResultsV3.structure.test.ts).
//
// CONFIRMED ROOT CAUSE these guard: both scan-failure paths previously left the PRESERVED previous
// result on screen (`degraded` did a bare `return`; a thrown scan only called setError()), while the
// results block renders on `result` alone, independent of `error` — so a wallet whose live value had
// materially changed kept showing its OLD total after every failed rescan.
//
// Run with:
//   npx tsx --test app/terminal/wallet-scanner/page.scanStaleness.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8')

// Comment-stripped view, used for the "no setResult() escape hatch" guard below — the real code
// must not contain that call, but the file's own explanatory comments legitimately mention it by
// name, and a naive scan over raw source would match the prose instead of the code.
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

describe('wallet-scanner page — stale result can never survive a failed or degraded scan', () => {
  it('the degraded branch clears the result envelope before returning', () => {
    const degradedBranch = source.slice(source.indexOf('if (response.degraded)'), source.indexOf('if (!response.success'))
    assert.ok(degradedBranch.includes('setResultEnvelope(null)'), 'the degraded path must drop the stale envelope, not bare-return')
    assert.ok(degradedBranch.includes('setError('), 'the degraded path must still surface the error')
  })

  it('the catch branch clears the result envelope', () => {
    // The `finally` must be located AFTER the catch — this file has an earlier, unrelated
    // try/finally (loadWalletWatchlist) that a plain indexOf would otherwise latch onto.
    const catchStart = source.indexOf('} catch (err: unknown) {')
    assert.ok(catchStart > 0, 'expected the scan handler catch block to exist')
    const catchBranch = source.slice(catchStart, source.indexOf('} finally {', catchStart))
    assert.ok(catchBranch.includes('setResultEnvelope(null)'), 'a thrown/failed scan must drop the stale envelope')
  })

  it('there is no setResult() escape hatch — the report can only change together with its scan identity', () => {
    assert.ok(!/\bsetResult\s*\(/.test(codeOnly), 'a bare setResult() would allow a report to be swapped without its jobId/completedAt')
  })

  it('the completed-scan path replaces the whole envelope atomically with report + jobId + completedAt', () => {
    assert.match(source, /const envelope: WalletScanEnvelope = \{ report, jobId: scanJobId, completedAt: Date\.now\(\) \}/)
    assert.match(source, /setResultEnvelope\(envelope\)/)
  })

  it('the displayed report is derived read-only from the single envelope', () => {
    assert.match(source, /const result = resultEnvelope\?\.report \?\? null/)
  })

  it('a refresh preserves the previous envelope INTACT (never a partially-updated hybrid)', () => {
    assert.match(source, /setResultEnvelope\(\(prev\) => \(prev && resolvePreservedResultOnScanStart\(prev\.report, address\) \? prev : null\)\)/)
  })

  it('a "Refreshing…" indicator is shown while a previous result is still on screen', () => {
    assert.match(source, /Refreshing…/)
  })

  it('scan identity is logged for the completed scan', () => {
    assert.match(source, /logScanIdentityIfDev\(envelope\)/)
  })
})

describe('wallet-scanner page — every V3 surface consumes ONE canonical result', () => {
  it('WalletScannerResultsV3 receives the derived `result`, so header/cards/holdings/chains share one scan', () => {
    const v3Block = source.slice(source.indexOf('<WalletScannerResultsV3'), source.indexOf('/>', source.indexOf('<WalletScannerResultsV3')))
    assert.match(v3Block, /report=\{result\}/, 'all V3 surfaces must be fed from the one derived canonical result')
  })

  it('no displayed total is sourced from the legacy V1 portfolio field ahead of the canonical one', () => {
    // Every real read of a total in this file prefers portfolioV2 first; the V1 field may only ever
    // appear as a `??` fallback after it.
    const v1Reads = source.match(/report\??\.?\bportfolio\?\.totalValueUsd/g) ?? []
    for (const read of v1Reads) {
      const idx = source.indexOf(read)
      const preceding = source.slice(Math.max(0, idx - 120), idx)
      assert.ok(
        preceding.includes('portfolioV2?.totalValueUsd'),
        `a V1 total read must always be preceded by the canonical portfolioV2 total: ...${preceding.slice(-60)}`,
      )
    }
  })
})
