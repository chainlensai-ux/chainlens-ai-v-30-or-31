import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  resolveSolanaHolderConcentration,
  solanaHolderConcentrationCacheKey,
  isSolanaConcentrationCacheEntryForMint,
} from '../lib/server/solana/holderConcentrationResolver'
import { __resetMemoryFallbackForTest, getTokenCache, setTokenCache } from '../lib/server/cache/tokenCache'

// Two real-looking base58 mints made of the same letters, differing only by case.
const MINT_A = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'
const MINT_B = 'ekPqgsJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'
const RPC = 'https://rpc.example/solana'

function mockLargest(amounts: string[]) {
  const calls: string[] = []
  const impl = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push(`${body.method}:${body.params?.[0]}`)
    const value = amounts.map((amount, i) => ({ address: `Acct${i}${body.params?.[0]}`, amount }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }), { status: 200 })
  }) as unknown as Parameters<typeof resolveSolanaHolderConcentration>[0]['fetchImpl']
  return { impl, calls }
}

const run = (mintAddress: string, fetchImpl: Parameters<typeof resolveSolanaHolderConcentration>[0]['fetchImpl']) =>
  resolveSolanaHolderConcentration({ mintAddress, chainSlug: 'solana', rpcUrl: RPC, fetchImpl, rawSupply: 1000, rawSupplyExact: '1000' })

describe('Solana concentration cache: exact case-sensitive mint identity', () => {
  const saved = { k: process.env.HELIUS_API_KEY, f: process.env.ENABLE_HELIUS_SOLANA }
  beforeEach(() => {
    __resetMemoryFallbackForTest()
    // Helius off so each miss is exactly one getTokenLargestAccounts call.
    delete process.env.HELIUS_API_KEY; delete process.env.ENABLE_HELIUS_SOLANA
  })
  afterEach(() => {
    if (saved.k !== undefined) process.env.HELIUS_API_KEY = saved.k
    if (saved.f !== undefined) process.env.ENABLE_HELIUS_SOLANA = saved.f
  })

  it('mints that differ only by case produce different cache keys, with the mint kept verbatim', () => {
    const a = solanaHolderConcentrationCacheKey('solana', MINT_A)
    const b = solanaHolderConcentrationCacheKey('solana', MINT_B)
    assert.notEqual(a, b)
    assert.ok(a.endsWith(`:${MINT_A}`))
    assert.ok(b.endsWith(`:${MINT_B}`))
  })

  it('payload check rejects a different-case mint and accepts only the exact mint', () => {
    assert.equal(isSolanaConcentrationCacheEntryForMint({ mintAddress: MINT_A, chainSlug: 'solana' }, MINT_A, 'solana'), true)
    assert.equal(isSolanaConcentrationCacheEntryForMint({ mintAddress: MINT_A, chainSlug: 'solana' }, MINT_B, 'solana'), false)
    assert.equal(isSolanaConcentrationCacheEntryForMint({ mintAddress: MINT_A.toLowerCase(), chainSlug: 'solana' }, MINT_A, 'solana'), false)
    assert.equal(isSolanaConcentrationCacheEntryForMint(null, MINT_A, 'solana'), false)
  })

  it('exact same mint hits the cache: 1 call on the miss, 0 on the repeat, same Top1/10/20', async () => {
    const m = mockLargest(['500', '200', '100'])
    const first = await run(MINT_A, m.impl)
    assert.equal(first.audit.cacheHit, false)
    assert.equal(m.calls.length, 1)
    assert.equal(first.result.top1Percent, 50)
    assert.equal(first.result.top10Percent, 80)
    assert.equal(first.result.top20Percent, 80)
    const again = await run(MINT_A, m.impl)
    assert.equal(again.audit.cacheHit, true)
    assert.equal(m.calls.length, 1)
    assert.equal(again.result.source, 'cache')
    assert.deepEqual([again.result.top1Percent, again.result.top10Percent, again.result.top20Percent], [50, 80, 80])
  })

  it('cache for mint A never serves mint B (different case): B pays its own read', async () => {
    const mA = mockLargest(['900', '50'])
    await run(MINT_A, mA.impl)
    const mB = mockLargest(['100', '100'])
    const b = await run(MINT_B, mB.impl)
    assert.equal(b.audit.cacheHit, false)
    assert.deepEqual(mB.calls, [`getTokenLargestAccounts:${MINT_B}`])
    assert.equal(b.result.top1Percent, 10)
    const a = await run(MINT_A, mockLargest([]).impl)
    assert.equal(a.audit.cacheHit, true)
    assert.equal(a.result.top1Percent, 90)
  })

  it('a wrong-mint payload stored under the exact key is rejected, and old v1 lowercased entries are bypassed', async () => {
    const poisoned = { status: 'verified', topAccounts: [{ address: 'X', amountRaw: '999', percent: 99.9 }], top1Percent: 99.9, top10Percent: 99.9, top20Percent: 99.9, totalSupply: '1000', source: 'rpc_largest_accounts', confidence: 'high', publicReason: null, technicalReason: null, chainSlug: 'solana' }
    await setTokenCache(solanaHolderConcentrationCacheKey('solana', MINT_B), { ...poisoned, mintAddress: MINT_A }, 90)
    await setTokenCache(`solana:holderConcentration:v1:solana:${MINT_B.toLowerCase()}`, { ...poisoned, mintAddress: MINT_A.toLowerCase() }, 90)
    const m = mockLargest(['100'])
    const b = await run(MINT_B, m.impl)
    assert.equal(b.audit.cacheHit, false)
    assert.equal(m.calls.length, 1)
    assert.equal(b.result.top1Percent, 10)
    const stored = await getTokenCache<{ mintAddress: string }>(solanaHolderConcentrationCacheKey('solana', MINT_B))
    assert.equal(stored?.mintAddress, MINT_B)
  })

  it('no lowercasing or normalizing anywhere in the resolver', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/server/solana/holderConcentrationResolver.ts'), 'utf8')
    assert.ok(!/toLowerCase|toUpperCase|normalize\(/.test(src))
  })
})
