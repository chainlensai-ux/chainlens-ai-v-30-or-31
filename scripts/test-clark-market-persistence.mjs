import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Minimal localStorage stub so the 'use client' helper module can run under plain node.
function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
}
globalThis.window = globalThis.window ?? {}
globalThis.localStorage = makeLocalStorage()

const { persistMarketMomentum, readMarketMomentum } = await import('../lib/client/clarkMemory.ts')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routeSrc = fs.readFileSync(path.join(__dirname, '../app/api/clark/route.ts'), 'utf8')
const pageSrc = fs.readFileSync(path.join(__dirname, '../app/terminal/clark-ai/page.tsx'), 'utf8')
const routingSrc = fs.readFileSync(path.join(__dirname, '../lib/server/clarkRouting.ts'), 'utf8')
const PROVIDER_RE = /goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i

const tokenAddr = '0x' + '5'.repeat(40)

// 1. Persisting and reading back stores items + createdAt/expiresAt with a 15-minute window.
{
  globalThis.localStorage.removeItem('chainlens:lastMarketMomentum')
  const before = Date.now()
  persistMarketMomentum([{ rank: 1, symbol: 'VELVET', scanTarget: tokenAddr }])
  const raw = JSON.parse(globalThis.localStorage.getItem('chainlens:lastMarketMomentum'))
  assert.ok(Array.isArray(raw.items) && raw.items.length === 1)
  assert.ok(typeof raw.createdAt === 'number' && raw.createdAt >= before)
  assert.ok(typeof raw.expiresAt === 'number')
  assert.ok(raw.expiresAt - raw.createdAt === 15 * 60 * 1000, 'expiry window is 15 minutes')
  const read = readMarketMomentum()
  assert.equal(read[0].symbol, 'VELVET')
}

// 2. Expired entries are ignored, not returned.
{
  globalThis.localStorage.setItem('chainlens:lastMarketMomentum', JSON.stringify({
    items: [{ rank: 1, symbol: 'OLD', scanTarget: tokenAddr }],
    createdAt: Date.now() - 20 * 60 * 1000,
    expiresAt: Date.now() - 5 * 60 * 1000,
  }))
  assert.equal(readMarketMomentum(), null, 'expired persisted market context is ignored')
}

// 3. Malformed entries (missing items/expiresAt, broken JSON) are ignored safely.
{
  globalThis.localStorage.setItem('chainlens:lastMarketMomentum', 'not json')
  assert.equal(readMarketMomentum(), null, 'malformed JSON is ignored')
  globalThis.localStorage.setItem('chainlens:lastMarketMomentum', JSON.stringify({ items: 'not-an-array', expiresAt: Date.now() + 10000 }))
  assert.equal(readMarketMomentum(), null, 'malformed shape is ignored')
}

// 4. Frontend reads persisted momentum into appContext.marketContext.
assert.ok(/readMarketMomentum/.test(pageSrc), 'page.tsx reads persisted market momentum')
assert.ok(/persistMarketMomentum/.test(pageSrc), 'page.tsx persists market momentum on new market data')

// 5. Market actions never include Open Base Radar, and only include a scan CTA when a
//    scanTarget exists.
{
  const { buildClarkContextActions } = await import('../lib/server/clarkRouting.ts')
  const withTarget = buildClarkContextActions({ promptActionsEnabled: true }, 'market', { scanTarget: tokenAddr, symbol: 'VELVET', chain: 'base' })
  assert.ok(!withTarget.actions.some((a) => a.label === 'Open Base Radar'), 'market actions exclude Open Base Radar')
  assert.ok(withTarget.actions.some((a) => a.label.includes('Scan')), 'market actions include a scan CTA when scanTarget exists')

  const withoutTarget = buildClarkContextActions({ promptActionsEnabled: true }, 'market', { scanTarget: null })
  assert.ok(!withoutTarget.actions.some((a) => a.label === 'Open Base Radar'), 'market actions exclude Open Base Radar even without a target')
  assert.ok(!withoutTarget.actions.some((a) => a.label.includes('Scan ')), 'no scanTarget means no fake per-symbol scan CTA')
}

// 6. Backend market-intent CTAs (base momentum / base market discovery) never route Open Base Radar.
assert.ok(!/buildRoutedActions\(\["Open Base Radar", "Open Token Scanner"/.test(routeSrc), 'momentum/discovery CTAs no longer include Open Base Radar')

// 7. Backend exposes the follow-up scan status-message debug fields.
for (const field of [
  'clarkFollowupCommand', 'clarkFollowupResolvedFrom', 'clarkFollowupResolvedRank',
  'clarkFollowupResolvedSymbol', 'clarkFollowupScanTargetPresent', 'clarkFollowupStatusMessage',
]) {
  assert.ok(routeSrc.includes(field), `route exposes debug field ${field}`)
}

// 8. A resolved scan follow-up produces a "Scanning ... on Base" status message before the result.
assert.ok(/Scanning \$\{statusLabel\} on Base/.test(routeSrc), 'resolved scan follow-up builds a status message')
assert.ok(!PROVIDER_RE.test(routeSrc.match(/Scanning \$\{statusLabel\}[^\n]*\n[^\n]*/)?.[0] ?? ''), 'status message text has no provider names')

// 9. Frontend renders the status message as an interim message before the final reply.
assert.ok(/clarkFollowupStatusMessage/.test(pageSrc), 'frontend reads clarkFollowupStatusMessage from the payload')

// 10. Prompt CTAs still use kind:"prompt" and resend through handleSendText (unchanged contract).
assert.ok(/action\.kind === 'prompt'/.test(pageSrc), 'frontend still branches on action.kind for prompt actions')
assert.ok(/handleSendText\(action\.prompt/.test(pageSrc), 'prompt actions still resend through handleSendText')

// 11. No new provider names anywhere touched.
assert.ok(!PROVIDER_RE.test(routingSrc.slice(routingSrc.indexOf('isMarketIntent'), routingSrc.indexOf('isMarketIntent') + 800)))

// 12. persistMarketMomentum() never overwrites a previously persisted list with an empty one —
//     a transient empty market response must not erase real prior context.
{
  globalThis.localStorage.removeItem('chainlens:lastMarketMomentum')
  persistMarketMomentum([{ rank: 1, symbol: 'VELVET', scanTarget: tokenAddr }])
  persistMarketMomentum([])
  const read = readMarketMomentum()
  assert.ok(read && read.length === 1 && read[0].symbol === 'VELVET', 'empty momentum write does not clear prior persisted context')
}

console.log('clark market persistence checks passed')
