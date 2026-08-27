import assert from 'node:assert/strict'
import fs from 'node:fs'

const preloadSrc = fs.readFileSync(new URL('../lib/useDrawerPreload.ts', import.meta.url), 'utf8')
const enrichmentSrc = fs.readFileSync(new URL('../app/api/base-radar/enrichment/route.ts', import.meta.url), 'utf8')
const vercelSrc = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
const radarPageSrc = fs.readFileSync(new URL('../app/terminal/base-radar/page.tsx', import.meta.url), 'utf8')

assert.match(preloadSrc, /Authorization: `Bearer \$\{token\}`/, 'drawer preload fetchJson must send the session Bearer token')
assert.match(preloadSrc, /'robinhood'/, 'ChainKey must include robinhood')
assert.match(radarPageSrc, /chain: token\.chain/, 'TokenCard must pass the token chain into preload')
assert.match(enrichmentSrc, /cacheKey\(chain, contract, plan\)/, 'enrichment cacheKey must include plan')
assert.match(enrichmentSrc, /payloadSkipsCache/, 'requires_pro / limited_evidence payloads must skip cache')
assert.match(vercelSrc, /"app\/api\/base-radar\/enrichment\/route\.ts": \{ "maxDuration": 60 \}/, 'enrichment maxDuration must be 60')

console.log('test-radar-enrichment-auth.mjs: all assertions passed')
