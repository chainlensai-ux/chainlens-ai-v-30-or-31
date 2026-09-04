// Behavioral test for POST /api/resolve — every DexScreener/GeckoTerminal call is served by an
// injected fetch stub (mirrors the pattern already used by scripts/test-paypal-payments.mjs), no
// real network calls.
import assert from 'node:assert/strict'
import { POST } from '../app/api/resolve/route.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const originalFetch = globalThis.fetch

function dexPair({ address, chainId, symbol, name, liquidityUsd, volume24hUsd, fdvUsd, pairAddress }) {
  return {
    chainId, pairAddress: pairAddress ?? `${address}-pair`,
    baseToken: { address, symbol, name },
    liquidity: { usd: liquidityUsd },
    volume: { h24: volume24hUsd },
    fdv: fdvUsd,
  }
}

function mockFetch(dexPairs) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('api.dexscreener.com')) {
      return { ok: true, json: async () => ({ pairs: dexPairs }) }
    }
    if (u.includes('api.geckoterminal.com')) {
      return { ok: true, json: async () => ({ data: [] }) }
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
}
function restoreFetch() { globalThis.fetch = originalFetch }

function resolveRequest(body) {
  return new Request('https://app.example/api/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function run() {
  console.log('\nSection 1: direct contract address resolves immediately, no provider calls')
  {
    globalThis.fetch = async (url) => { throw new Error(`should not fetch: ${url}`) }
    const res = await POST(resolveRequest({ query: '0x1234567890123456789012345678901234567890', chain: 'base' }))
    const json = await res.json()
    restoreFetch()
    check('status resolved', json.status === 'resolved')
    check('contractAddress echoed back lowercased', json.contractAddress === '0x1234567890123456789012345678901234567890')
    check('needsUserChoice is false for a direct CA', json.needsUserChoice === false)
    check('query/normalizedQuery are populated', json.query && json.normalizedQuery)
  }

  console.log('\nSection 2: internal alias (AERO) resolves instantly with a populated matches array')
  {
    globalThis.fetch = async (url) => { throw new Error(`should not fetch: ${url}`) }
    const res = await POST(resolveRequest({ query: 'AERO', chain: 'base' }))
    const json = await res.json()
    restoreFetch()
    check('status resolved', json.status === 'resolved')
    check('bestCandidate symbol is AERO', json.bestCandidate?.symbol === 'AERO')
    check('matches array carries the spec-shaped match too', json.matches.length === 1 && json.matches[0].symbol === 'AERO')
    check('selectedMatch is populated for a confident resolve', json.selectedMatch?.symbol === 'AERO')
  }

  console.log('\nSection 3: two real, comparably-ranked exact-symbol matches on different chains → ambiguous, never silently picked')
  {
    mockFetch([
      dexPair({ address: '0x1111111111111111111111111111111111111a1a', chainId: 'base', symbol: 'PEPE', name: 'Pepe Base', liquidityUsd: 500_000, volume24hUsd: 200_000, fdvUsd: 1_000_000 }),
      dexPair({ address: '0x2222222222222222222222222222222222222b2b', chainId: 'ethereum', symbol: 'PEPE', name: 'Pepe Ethereum', liquidityUsd: 480_000, volume24hUsd: 190_000, fdvUsd: 980_000 }),
    ])
    const res = await POST(resolveRequest({ query: 'PEPE', chain: '' }))
    const json = await res.json()
    restoreFetch()
    check('status is ambiguous, not silently resolved to one of the two', json.status === 'ambiguous')
    check('needsUserChoice is true', json.needsUserChoice === true)
    check('selectedMatch is null — nothing auto-picked on a genuine tie', json.selectedMatch === null)
    check('matches array carries both real candidates', json.matches.length === 2)
    check('reason tells the user to choose, never claims a confident single resolve', /Choose one to scan/i.test(json.reason))
  }

  console.log('\nSection 4: one dominant match with a distant second candidate resolves confidently (chain preference still applies)')
  {
    mockFetch([
      dexPair({ address: '0x3333333333333333333333333333333333333c3c', chainId: 'base', symbol: 'MOONPUP', name: 'Moon Pup', liquidityUsd: 5_000_000, volume24hUsd: 2_000_000, fdvUsd: 50_000_000 }),
      dexPair({ address: '0x4444444444444444444444444444444444444d4d', chainId: 'solana', symbol: 'MOONPUPX', name: 'Moon Pup Clone', liquidityUsd: 500, volume24hUsd: 10, fdvUsd: 1000 }),
    ])
    const res = await POST(resolveRequest({ query: 'MOONPUP', chain: 'base' }))
    const json = await res.json()
    restoreFetch()
    check('status resolved — the dominant Base match wins cleanly', json.status === 'resolved')
    check('resolved to the Base MOONPUP contract, preserving the selected chain', json.contractAddress === '0x3333333333333333333333333333333333333c3c')
    check('needsUserChoice is false', json.needsUserChoice === false)
  }

  console.log('\nSection 5: no matches anywhere → honest not_found, never a guess')
  {
    mockFetch([])
    const res = await POST(resolveRequest({ query: 'ZZZNOTATOKENZZZ', chain: 'base' }))
    const json = await res.json()
    restoreFetch()
    check('status not_found', json.status === 'not_found')
    check('failureReason is populated', json.failureReason === 'no_matches')
    check('contractAddress is null, never a fabricated guess', json.contractAddress === null)
  }

  console.log(`\n${passed} assertions passed`)
}

run().catch((err) => { console.error(err); process.exit(1) })
