// TESTS — alchemyCallAttribution (Alchemy cost-audit follow-up task, issue #3): required regression
// — every real eth_getBalance call site must emit a structured [alchemy-call-attribution] log with
// route/worker/module/chain/jobId/scanMode and a non-reversible key fingerprint.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logAlchemyCallAttribution, fingerprintAlchemyKey } from './alchemyCallAttribution'

function captureWarnings(): { calls: unknown[][]; restore: () => void } {
  const original = console.warn
  const calls: unknown[][] = []
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => { calls.push(args) }
  return { calls, restore: () => { console.warn = original } }
}

test('HARD ASSERTION (required regression): every eth_getBalance attribution call emits a structured [alchemy-call-attribution] log with route/worker/module/chain/jobId/scanMode/keyFingerprint', () => {
  const { calls, restore } = captureWarnings()
  try {
    logAlchemyCallAttribution({
      route: '/api/whale-alerts', worker: null, module: 'onChainEnrichment', chain: 'base',
      jobId: null, scanMode: null, method: 'eth_getBalance', keyFingerprint: '***abcd',
    })
    const entry = calls.find((c) => c[0] === '[alchemy-call-attribution]')
    assert.ok(entry, 'must log the [alchemy-call-attribution] tag')
    const attribution = entry![1] as Record<string, unknown>
    assert.equal(attribution.method, 'eth_getBalance')
    assert.equal(attribution.route, '/api/whale-alerts')
    assert.equal(attribution.chain, 'base')
    assert.ok('worker' in attribution)
    assert.ok('module' in attribution)
    assert.ok('jobId' in attribution)
    assert.ok('scanMode' in attribution)
    assert.ok('keyFingerprint' in attribution)
  } finally {
    restore()
  }
})

test('fingerprintAlchemyKey never returns the raw key — only a short, non-reversible suffix', () => {
  const fp = fingerprintAlchemyKey('a-real-looking-alchemy-api-key-1234')
  assert.ok(fp)
  assert.ok(!fp!.includes('a-real-looking-alchemy-api-key'), 'must never leak the key body')
  assert.equal(fp, '***1234')
})

test('fingerprintAlchemyKey returns null (never a fabricated fingerprint) when no key is supplied', () => {
  assert.equal(fingerprintAlchemyKey(null), null)
  assert.equal(fingerprintAlchemyKey(undefined), null)
  assert.equal(fingerprintAlchemyKey(''), null)
})

test('a worker-context attribution (module/jobId/scanMode populated) round-trips through the log call unchanged', () => {
  const { calls, restore } = captureWarnings()
  try {
    logAlchemyCallAttribution({
      route: '/api/wallet-scan', worker: 'walletScanV2', module: 'holdings', chain: 'eth',
      jobId: 'job-123', scanMode: 'deep', method: 'eth_getBalance', keyFingerprint: '***wxyz',
    })
    const attribution = calls.find((c) => c[0] === '[alchemy-call-attribution]')![1] as Record<string, unknown>
    assert.equal(attribution.worker, 'walletScanV2')
    assert.equal(attribution.jobId, 'job-123')
    assert.equal(attribution.scanMode, 'deep')
  } finally {
    restore()
  }
})
