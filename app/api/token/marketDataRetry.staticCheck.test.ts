// GECKOTERMINAL/DEXSCREENER-SINGLE-ATTEMPT-FLAKE FIX, DISCLOSED: found in the same investigation as
// the fetchGoldRush chain-slug bug (fixed in goldrushChainSlug.staticCheck.test.ts) — a live report
// of BNB token scans intermittently coming back with no market data at all, still reproducing after
// that fix shipped and after retrying the exact same query several times in a row with a consistent
// (not flip-flopping) chain detection. GeckoTerminal and DexScreener are this route's market-data
// sources for pools/price/liquidity/volume, and every call to either was a single fetch attempt
// with a short timeout (5s / 4s respectively) — one slow response or transient 5xx/429 killed that
// scan's entire market-data read with no second try, unlike the GoldRush/Covalent calls in this
// file which already retry across hosts via fetchGoldRushWithHostFallback. A real 404 (the token
// genuinely has no pools/pairs on that network) is deliberately NOT retried in either fix — retrying
// a true negative just wastes time confirming the same answer.
//
// Run directly with:
//   npx tsx --test app/api/token/marketDataRetry.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')

describe('GeckoTerminal calls retry once on a transient failure, never on a genuine 404', () => {
  it('fetchGeckoTerminalWithRetry exists and does not retry a real not-found', () => {
    const fnStart = src.indexOf('async function fetchGeckoTerminalWithRetry(url: string, timeoutMs = 5000): Promise<Response | null> {')
    assert.notEqual(fnStart, -1, 'a dedicated GeckoTerminal retry helper must exist')
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    assert.match(fnBody, /if \(res\.ok \|\| res\.status === 404 \|\| attempt === 1\) return res;/, 'a 404 must return immediately without a retry — it is a genuine not-found, not a flake')
    assert.match(fnBody, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/, 'the helper must attempt at most twice (one retry), not loop indefinitely')
  })

  it('fetchGeckoTerminal (pools) and fetchGeckoTerminalToken both route through the retry helper', () => {
    assert.match(src, /const res = await fetchGeckoTerminalWithRetry\(\s*\n\s*`\$\{_gtBase\}\/api\/v2\/networks\/\$\{network\}\/tokens\/\$\{contract\}\/pools\?page=1&include=base_token%2Cquote_token`\s*\n\s*\);/, 'the pools lookup (primary market-data source) must use the retry helper')
    assert.match(src, /const res = await fetchGeckoTerminalWithRetry\(`\$\{_gtBase\}\/api\/v2\/networks\/\$\{network\}\/tokens\/\$\{contract\}`\);/, 'the token-info lookup must use the retry helper')
  })
})

describe('DexScreener fallback retries once on a transient failure, never on a genuine 404', () => {
  it('fetchDexScreenerFallback retries up to twice and stops immediately on ok or 404', () => {
    const lines = src.split('\n')
    const startLine = lines.findIndex((l) => l.startsWith('async function fetchDexScreenerFallback('))
    assert.notEqual(startLine, -1, 'fetchDexScreenerFallback must still exist with this signature')
    const nextFnLine = lines.findIndex((l, i) => i > startLine && /^async function /.test(l))
    assert.notEqual(nextFnLine, -1, 'must find the next top-level function to bound the search')
    const fnBody = lines.slice(startLine, nextFnLine).join('\n')
    assert.match(fnBody, /for \(let attempt = 0; attempt < 2; attempt\+\+\) \{/, 'the fetch must be attempted at most twice (one retry)')
    assert.match(fnBody, /if \(res && \(res\.ok \|\| res\.status === 404\)\) break/, 'a real 404 or a successful response must stop retrying immediately')
  })
})

console.log('marketDataRetry.staticCheck.test.ts: source assertions defined via node:test above')
