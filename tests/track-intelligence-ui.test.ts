import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as intelligence from '../lib/trackIntelligence'
import type { TrackedOutcome } from '../lib/tokenOutcomes'

// Render the real presentation with the real comparison module. Only Next's CSS-module
// loader is substituted; no DOM, provider or evidence behavior is mocked.
const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../components/outcomes/TrackIntelligence.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
const exports: { TrackIntelligence?: ComponentType<{ row: TrackedOutcome }> } = {}
new Function('require', 'exports', compiled)((id: string) => id === '@/lib/trackIntelligence' ? intelligence
  : id.endsWith('.module.css') ? { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) } : require(id), exports)
const Component = exports.TrackIntelligence!
const observedAt = '2026-10-04T00:00:00Z'
function row(): TrackedOutcome {
  return {
    id: 'ui-receipt', chain: 'base', token_address: '0xtoken', last_checked_at: observedAt,
    baseline_liquidity_usd: 161000, baseline_price_usd: null, baseline_market_cap_usd: null,
    current_price_usd: null, current_liquidity_usd: 149000, market_source: 'dexscreener', outcome_status: 'watching',
    baseline_snapshot_json: { scannedAt: '2026-09-23T00:00:00Z', baselineRiskScore: 62, baselineHolderSignals: { top10: 63.7 } },
    market_observation_json: { provider: 'dexscreener', selectedPoolAddress: 'pool', trackIntelligence: {
      snapshot: { observedAt, scannerObservedAt: observedAt, top10Pct: null, riskScore: null, deployerActivity: null }, events: [],
    } },
  } as unknown as TrackedOutcome
}
const render = (r = row()) => renderToStaticMarkup(createElement(Component, { row: r }))
test('four compact cards preserve unavailable current values without implying zero', () => {
  const html = render()
  assert.equal((html.match(/class="trackMetric"/g) ?? []).length, 4)
  assert.match(html, /No verified dev activity/)
  assert.match(html, /Coverage incomplete/)
  assert.match(html, /Current unavailable/)
  assert.doesNotMatch(html, /0 verified transfers|No activity →/)
})
test('incompatible liquidity displays both values but no comparison arrow or delta', () => {
  const html = render()
  assert.match(html, /\$161K/)
  assert.match(html, /\$149K/)
  assert.match(html, /Different or unrecorded liquidity basis/)
  assert.doesNotMatch(html, /aria-label="compared with"/)
  assert.doesNotMatch(html, /-7\.5%/)
})
test('compatible liquidity displays arrow and existing computed delta', () => {
  const r = row()
  r.baseline_snapshot_json.trackComparison = { liquidityBasis: 'pool:base:pool:usd-reserves' }
  const html = render(r)
  assert.match(html, /aria-label="compared with"/)
  assert.match(html, /-7\.5%/)
})
test('methodology mismatch remains explicit, never a risk-score arrow', () => {
  const r = row()
  r.baseline_snapshot_json.trackComparison = { riskMethodologyVersion: 'v1' }
  Object.assign(r.market_observation_json!.trackIntelligence!.snapshot, { riskScore: 74, riskMethodologyVersion: 'v2' })
  const html = render(r)
  assert.match(html, /Methodology changed/)
  assert.match(html, /Current: 74/)
  assert.doesNotMatch(html, /aria-label="compared with"/)
})
test('empty timeline keeps the creation event and specific rug wording', () => {
  const html = render()
  assert.match(html, /No material post-scan events yet/)
  assert.match(html, /Original scan created/)
  assert.match(html, /Frozen scan receipt/)
  assert.match(html, /No verified rug event observed/)
  assert.doesNotMatch(html, /No verified risk event/)
})
test('material changes keep semantic direction and newest-first timeline', () => {
  const r = row()
  r.baseline_snapshot_json.trackComparison = { liquidityBasis: 'pool:base:pool:usd-reserves' }
  r.current_liquidity_usd = 100000
  const html = render(r)
  assert.match(html, /1 important change/)
  assert.match(html, /data-tone="negative"/)
  assert.ok(html.indexOf('dateTime="2026-10-04') < html.indexOf('dateTime="2026-09-23'))
})
test('both evidence disclosures are collapsed and data remains present', () => {
  const receipt = readFileSync(new URL('../components/outcomes/OutcomeCard.tsx', import.meta.url), 'utf8')
  assert.match(receipt, /<details className=\{styles.why\}><summary>Original scan evidence/)
  assert.match(receipt, /<details className=\{styles.after\}><summary>What happened afterward/)
  assert.match(receipt, /row.outcome_reasons_json.map/)
  assert.doesNotMatch(receipt, /<details[^>]+\bopen[\s=>]/)
})
