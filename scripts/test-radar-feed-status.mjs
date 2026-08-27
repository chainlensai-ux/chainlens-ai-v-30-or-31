import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const tsPath = path.join(root, 'lib/radarFeedStatus.ts')
const pagePath = path.join(root, 'app/terminal/base-radar/page.tsx')

const ts = fs.readFileSync(tsPath, 'utf8')
assert.match(ts, /export function radarErrorMessage/)
assert.match(ts, /export function radarHasVisibleFeed/)
assert.match(ts, /export function radarStatTileMode/)
assert.match(ts, /export function radarTimeoutMessage/)
assert.match(ts, /export function radarVisibleErrorFromPayload/)

// Strip TypeScript to runnable ESM so this test does not need tsx.
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
js = js.replace(/\{ tokens\?: unknown \}/g, '')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-feed-status-'))
const tmpFile = path.join(tmpDir, 'radarFeedStatus.mjs')
writeFileSync(tmpFile, js + '\nexport {\n  radarHasVisibleFeed,\n  radarErrorMessage,\n  radarTimeoutMessage,\n  radarVisibleErrorFromPayload,\n  radarStatTileMode,\n}\n')

const mod = await import(pathToFileURL(tmpFile).href)
const {
  radarHasVisibleFeed,
  radarErrorMessage,
  radarTimeoutMessage,
  radarVisibleErrorFromPayload,
  radarStatTileMode,
} = mod

// hasData false → refresh/scan suffix, never "last available read"
const noDataGeneric = radarErrorMessage(500, false)
assert.match(noDataGeneric, /Try refreshing or scanning a token directly\./)
assert.doesNotMatch(noDataGeneric, /Showing last available read\./)

const noData429 = radarErrorMessage(429, false)
assert.match(noData429, /Try refreshing or scanning a token directly\./)
assert.doesNotMatch(noData429, /Showing last available read\./)

// hasData true → last-read suffix
const withDataGeneric = radarErrorMessage(500, true)
assert.match(withDataGeneric, /Showing last available read\./)
assert.doesNotMatch(withDataGeneric, /Try refreshing or scanning a token directly\./)

const withData403 = radarErrorMessage(403, true)
assert.match(withData403, /Showing last available read\./)

// empty tokens after chain clear is hasData false
assert.equal(radarHasVisibleFeed(null), false)
assert.equal(radarHasVisibleFeed(undefined), false)
assert.equal(radarHasVisibleFeed({ tokens: [] }), false)
assert.equal(radarHasVisibleFeed({}), false)
assert.equal(radarHasVisibleFeed({ tokens: [{ symbol: 'X' }] }), true)

// 504/timeout copy does not claim a last read when none is shown
const timeoutNoData = radarTimeoutMessage(false)
assert.match(timeoutNoData, /timed out/i)
assert.doesNotMatch(timeoutNoData, /Showing last available read\./)
assert.match(timeoutNoData, /Try refreshing or scanning a token directly\./)

const timeout504 = radarErrorMessage(504, false)
assert.match(timeout504, /timed out/i)
assert.doesNotMatch(timeout504, /Showing last available read\./)

const timeout408 = radarErrorMessage(408, false)
assert.match(timeout408, /timed out/i)
assert.doesNotMatch(timeout408, /Showing last available read\./)

const timeoutWithData = radarTimeoutMessage(true)
assert.match(timeoutWithData, /timed out/i)
assert.match(timeoutWithData, /Showing last available read\./)

// payload-aware copy: userVisibleError wins; provider source is quoted
const fromUser = radarVisibleErrorFromPayload({
  baseRadarLoadAudit: { userVisibleError: 'GeckoTerminal timed out on Robinhood.' },
}, 500, false)
assert.equal(fromUser, 'GeckoTerminal timed out on Robinhood.')

const fromSource = radarVisibleErrorFromPayload({
  baseRadarLoadAudit: { providerErrors: [{ source: 'geckoterminal' }, { source: 'dexscreener' }] },
}, 500, false)
assert.match(fromSource, /geckoterminal/)
assert.match(fromSource, /dexscreener/)
assert.doesNotMatch(fromSource, /Showing last available read\./)

const from504 = radarVisibleErrorFromPayload(null, 504, false)
assert.match(from504, /timed out/i)
assert.doesNotMatch(from504, /Showing last available read\./)

// tile mode: loading && !data && !error → checking; error && !data → unavailable;
// data exists (even during background refresh) → ready
assert.equal(radarStatTileMode({ loading: true, hasData: false, error: null }), 'checking')
assert.equal(radarStatTileMode({ loading: false, hasData: false, error: 'Radar refresh failed.' }), 'unavailable')
assert.equal(radarStatTileMode({ loading: true, hasData: true, error: null }), 'ready')
assert.equal(radarStatTileMode({ loading: false, hasData: true, error: 'Radar refresh failed.' }), 'ready')
assert.equal(radarStatTileMode({ loading: false, hasData: false, error: null }), 'unavailable')

// page.tsx must import helpers and reset hasRadarDataRef on chain clear
const page = fs.readFileSync(pagePath, 'utf8')
assert.match(page, /from '@\/lib\/radarFeedStatus'/)
assert.match(page, /hasRadarDataRef\.current = false/)
assert.match(page, /hasRadarDataRef\.current = radarHasVisibleFeed/)
assert.match(page, /radarVisibleErrorFromPayload/)
assert.match(page, /radarTimeoutMessage/)
assert.match(page, /placeholder\('Unavailable'\)/)
assert.match(page, /export default/)
assert.doesNotMatch(page, /function radarErrorMessage\(/)
assert.match(page, /RADAR_CHAINS\.map/)
assert.doesNotMatch(page, /visibleChains = RADAR_CHAINS\.filter/)

console.log('test-radar-feed-status.mjs: all assertions passed')
