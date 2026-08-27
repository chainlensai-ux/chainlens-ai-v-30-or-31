import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const tsPath = path.join(root, 'lib/whaleFeedStatus.ts')
const pagePath = path.join(root, 'app/terminal/whale-alerts/page.tsx')

const ts = fs.readFileSync(tsPath, 'utf8')
assert.match(ts, /export function whaleHasScanEvidence/)
assert.match(ts, /export function whaleKpiTile/)
assert.match(ts, /Not scanned yet/)
assert.match(ts, /Checking/)
assert.match(ts, /Unavailable/)

let js = ts
  .replace(/export type [^=\n]+=[\s\S]*?\n(?=\n|export |function |type )/g, '\n')
  .replace(/^type [^=\n]+=[\s\S]*?\n(?=\n|export |function |type )/gm, '\n')
js = js.replace(/export /g, '')
js = js.replace(/\)\s*:\s*[^=\n{]+\s*\{/g, ') {')
js = js.replace(/\(([^)]*)\)/g, (full, inner) => {
  const stripped = inner.replace(/(\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[^,)=]+/g, '$1$2')
  return `(${stripped})`
})
js = js.replace(/ as \{[^}]+\}/g, '')
js = js.replace(/ as [A-Za-z0-9_]+/g, '')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-feed-status-'))
const tmpFile = path.join(tmpDir, 'whaleFeedStatus.mjs')
writeFileSync(tmpFile, js + '\nexport {\n  whaleHasScanEvidence,\n  whaleKpiTile,\n  WHALE_KPI_EM_DASH,\n  WHALE_KPI_NOT_SCANNED,\n  WHALE_KPI_CHECKING,\n  WHALE_KPI_UNAVAILABLE,\n}\n')

const mod = await import(pathToFileURL(tmpFile).href)
const {
  whaleHasScanEvidence,
  whaleKpiTile,
  WHALE_KPI_EM_DASH,
  WHALE_KPI_NOT_SCANNED,
  WHALE_KPI_CHECKING,
  WHALE_KPI_UNAVAILABLE,
} = mod

// not-scanned → em dash + Not scanned yet
const notScanned = whaleKpiTile({
  loading: false,
  feedError: false,
  hasScanEvidence: false,
  feedSettled: true,
  value: 0,
  zeroSub: 'Quiet this window',
  readySub: 'Rolling',
})
assert.equal(notScanned.display, WHALE_KPI_EM_DASH)
assert.equal(notScanned.sub, WHALE_KPI_NOT_SCANNED)
assert.equal(notScanned.mode, 'not_scanned')
assert.notEqual(notScanned.display, 0)
assert.notEqual(notScanned.sub, 'Quiet this window')

// measured zero → Quiet copy
const quiet = whaleKpiTile({
  loading: false,
  feedError: false,
  hasScanEvidence: true,
  feedSettled: true,
  value: 0,
  zeroSub: 'Quiet this window',
  readySub: 'Rolling',
})
assert.equal(quiet.display, 0)
assert.equal(quiet.sub, 'Quiet this window')
assert.equal(quiet.mode, 'quiet')

const quietHour = whaleKpiTile({
  loading: false,
  feedError: false,
  hasScanEvidence: true,
  feedSettled: true,
  value: 0,
  zeroSub: 'No signal past hour',
  readySub: 'Rolling',
})
assert.equal(quietHour.sub, 'No signal past hour')

// error → Unavailable
const unavailable = whaleKpiTile({
  loading: false,
  feedError: true,
  hasScanEvidence: false,
  feedSettled: true,
  value: 0,
  zeroSub: 'Quiet this window',
  readySub: 'Rolling',
})
assert.equal(unavailable.display, WHALE_KPI_EM_DASH)
assert.equal(unavailable.sub, WHALE_KPI_UNAVAILABLE)
assert.equal(unavailable.mode, 'unavailable')

// loading unknown → Checking
const checking = whaleKpiTile({
  loading: true,
  feedError: false,
  hasScanEvidence: false,
  feedSettled: false,
  value: 0,
  zeroSub: 'Quiet this window',
  readySub: 'Rolling',
})
assert.equal(checking.display, WHALE_KPI_EM_DASH)
assert.equal(checking.sub, WHALE_KPI_CHECKING)
assert.equal(checking.mode, 'checking')
assert.notEqual(checking.display, 0)

// first-paint lie: stats 0, loading false, no settle, no scan → still Checking, never Quiet
const firstPaint = whaleKpiTile({
  loading: false,
  feedError: false,
  hasScanEvidence: false,
  feedSettled: false,
  value: 0,
  zeroSub: 'Quiet this window',
  readySub: 'Rolling',
})
assert.equal(firstPaint.mode, 'checking')
assert.equal(firstPaint.display, WHALE_KPI_EM_DASH)

// ready numeric
const ready = whaleKpiTile({
  loading: false,
  feedError: false,
  hasScanEvidence: true,
  feedSettled: true,
  value: 4,
  zeroSub: 'Quiet this window',
  readySub: 'Rolling',
})
assert.equal(ready.display, 4)
assert.equal(ready.sub, 'Rolling')
assert.equal(ready.mode, 'ready')

// tracked wallets string is never unknown-zero
const tracked = whaleKpiTile({
  loading: true,
  feedError: false,
  hasScanEvidence: false,
  feedSettled: false,
  value: '60+',
  zeroSub: null,
  readySub: 'Smart money + manual',
})
assert.equal(tracked.display, '60+')
assert.equal(tracked.mode, 'ready')

assert.equal(whaleHasScanEvidence({ syncState: null, alertCount: 0, diagnostics: null }), false)
assert.equal(whaleHasScanEvidence({ syncState: null, alertCount: 0, diagnostics: { rawRows: 0 } }), false)
assert.equal(whaleHasScanEvidence({ syncState: { ok: true }, alertCount: 0, diagnostics: null }), true)
assert.equal(whaleHasScanEvidence({ syncState: null, alertCount: 2, diagnostics: null }), true)
assert.equal(whaleHasScanEvidence({ syncState: null, alertCount: 0, diagnostics: { rawRows: 3 } }), true)

if (fs.existsSync(pagePath)) {
  const page = fs.readFileSync(pagePath, 'utf8')
  if (page.includes("from '@/lib/whaleFeedStatus'")) {
    assert.match(page, /whaleKpiTile/)
    assert.match(page, /AbortSignal\.timeout/)
    assert.match(page, /Not scanned yet|whaleHasScanEvidence/)
    assert.match(page, /syncWindowParam/)
    assert.doesNotMatch(page, /window: '7d'/)
  }
}

console.log('test-whale-feed-status.mjs: all assertions passed')
