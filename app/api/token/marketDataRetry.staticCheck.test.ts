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

// P0 GECKOTERMINAL RATE-LIMIT INCIDENT: the helper now delegates to the shared guard
// (lib/server/providers/geckoTerminalGuard.ts). Its behaviour — one bounded retry for a network error or
// 5xx, none for a 404, and never for a 429 (which opens the shared cooldown instead) — is tested directly
// in tests/geckoterminal-guard.test.ts.
describe('GeckoTerminal calls retry once on a transient failure, never on a genuine 404 or a 429', () => {
  it('fetchGeckoTerminalWithRetry exists and goes through the shared GeckoTerminal guard', () => {
    const fnStart = src.indexOf('async function fetchGeckoTerminalWithRetry(url: string, timeoutMs = 5000): Promise<Response | null> {')
    assert.notEqual(fnStart, -1, 'a dedicated GeckoTerminal retry helper must exist')
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    assert.match(fnBody, /return await geckoTerminalFetch\(url, \{ headers: \{ Accept: 'application\/json;version=20230302' \}, cache: 'no-store' \}, \{ route: 'token', timeoutMs \}\)/, 'the helper must use the shared guard (bounded retry, no 429 retry, shared cooldown)')
    assert.doesNotMatch(fnBody, /for \(let attempt/, 'no local retry loop on top of the guard')
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
    assert.match(fnBody, /if \(res && \(res.ok \|\| res.status === 404\)\) break/, 'a real 404 or a successful response must stop retrying immediately')
    assert.match(fnBody, /dexScreenerPairIsRequestedPricedToken/, 'Dex fallback may only price pairs where the requested token is baseToken')
  })
})

console.log('marketDataRetry.staticCheck.test.ts: source assertions defined via node:test above')
