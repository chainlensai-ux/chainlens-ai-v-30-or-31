import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  fetchHeliusHolderCount,
  finalizeHeliusHolderTally,
  heliusCountedAccountOwner,
  tallyHeliusTokenAccountPage,
  SOLANA_UNIQUE_OWNERS_PAGINATION_INCOMPLETE_REASON,
  SOLANA_UNIQUE_OWNERS_OWNER_MISSING_REASON,
  SOLANA_UNIQUE_OWNERS_CAP_REACHED_REASON,
  HELIUS_HOLDER_MAX_PAGES,
  HELIUS_HOLDER_TOTAL_BUDGET_MS,
  heliusOwnerLookupCoversAllAccounts,
  ownerCountEvidenceIsNewer,
  solanaOwnerCountCacheKey,
} from '../lib/server/solanaProviders'
import { __resetMemoryFallbackForTest } from '../lib/server/cache/tokenCache'
import { buildSolanaHolderCounts } from '../lib/server/solana/holderCounts'
import { formatSolanaTokenAccountLine, formatSolanaUniqueHolderLine } from '../lib/solanaHolderCountsDisplay'
import { annotateLiquidityCustody, buildSolanaCustodyCandidates } from '../lib/liquidityCustody'

const MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'
const W1 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const W2 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const W3 = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH'
const POOL_AUTH = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'
const VAULT = 'BQcdHdAQW1hczDbBi9hiegXAR7A98Q9jx3X3iBBBDiq4'

let n = 0
const acct = (owner: string | null, amount: string | number, extra: Record<string, unknown> = {}) => ({
  address: `Acct${String(++n).padStart(40, '0')}`,
  mint: MINT,
  owner,
  amount,
  ...extra,
})

function tallyOf(pages: unknown[][], complete: boolean) {
  const t = { accountOwner: new Map<string, string | null>(), accountAmount: new Map<string, bigint>(), pagesFetched: 0, lastIndexedSlot: null as number | null }
  for (const p of pages) tallyHeliusTokenAccountPage(t, MINT, p)
  return finalizeHeliusHolderTally(t, complete)
}

describe('Solana holder counts: token accounts vs unique owners', () => {
  it('one wallet with 3 ATAs adds 3 token accounts and 1 unique owner', () => {
    const r = tallyOf([[acct(W1, '10'), acct(W1, '20'), acct(W1, '30')]], true)
    assert.equal(r.tokenAccountCount, 3)
    assert.equal(r.holderCount, 3)
    assert.equal(r.uniqueOwnerCount, 1)
    assert.equal(r.uniqueOwnerStatus, 'verified')
  })

  it('excludes zero-balance accounts from both counts', () => {
    const r = tallyOf([[acct(W1, '10'), acct(W2, '0'), acct(W3, 0)]], true)
    assert.equal(r.tokenAccountCount, 1)
    assert.equal(r.uniqueOwnerCount, 1)
  })

  it('handles raw amounts beyond Number precision without dropping them', () => {
    const r = tallyOf([[acct(W1, '1'), acct(W2, '123456789012345678901234567890')]], true)
    assert.equal(r.tokenAccountCount, 2)
  })

  it('dedupes duplicate account rows (same address across pages)', () => {
    const a = acct(W1, '5')
    const r = tallyOf([[a, acct(W2, '5')], [{ ...a }]], true)
    assert.equal(r.tokenAccountCount, 2)
    assert.equal(r.uniqueOwnerCount, 2)
  })

  it('requires an exact, case-sensitive mint match', () => {
    const r = tallyOf([[acct(W1, '5'), acct(W2, '5', { mint: MINT.toLowerCase() }), acct(W3, '5', { mint: 'So11111111111111111111111111111111111111112' })]], true)
    assert.equal(r.tokenAccountCount, 1)
    assert.equal(r.uniqueOwnerCount, 1)
  })

  it('incomplete pagination leaves unique owners partial with no number', () => {
    const r = tallyOf([[acct(W1, '5'), acct(W2, '5')]], false)
    assert.equal(r.tokenAccountCount, 2)
    assert.equal(r.isLowerBound, true)
    assert.equal(r.uniqueOwnerCount, null)
    assert.equal(r.uniqueOwnerStatus, 'partial')
    assert.equal(r.uniqueOwnerReason, SOLANA_UNIQUE_OWNERS_PAGINATION_INCOMPLETE_REASON)
  })

  it('a counted account with no owner blocks a verified unique count', () => {
    const r = tallyOf([[acct(W1, '5'), acct(null, '5')]], true)
    assert.equal(r.tokenAccountCount, 2)
    assert.equal(r.uniqueOwnerCount, null)
    assert.equal(r.uniqueOwnerReason, SOLANA_UNIQUE_OWNERS_OWNER_MISSING_REASON)
  })

  it('AMM vault stays a token account, is reported as a pool authority owner, and keeps Stage 1 custody', () => {
    const vaultRow = { address: VAULT, mint: MINT, owner: POOL_AUTH, amount: '900' }
    const r = tallyOf([[vaultRow, acct(W1, '10'), acct(W1, '10'), acct(W2, '10')]], true)
    assert.equal(r.tokenAccountCount, 4)
    assert.equal(r.uniqueOwnerCount, 3)
    assert.equal(heliusCountedAccountOwner(r, VAULT), POOL_AUTH)
    const vaults = [{ address: VAULT, evidence: ['cluster_map_lp_vault_node'] }]
    const counts = buildSolanaHolderCounts({ heliusHolders: r, verifiedVaultAccounts: vaults, ownerOf: (a) => heliusCountedAccountOwner(r, a) })
    assert.equal(counts.verifiedCustodyOwnerCount, 1)
    assert.match(formatSolanaUniqueHolderLine(counts), /^3 unique owners \(includes 1 verified pool vault authority\)$/)
    const annot = annotateLiquidityCustody({
      chain: 'solana',
      holders: [{ address: VAULT, percent: 40, rank: 1 }, { address: 'Other1111111111111111111111111111111111111', percent: 5, rank: 2 }],
      candidates: buildSolanaCustodyCandidates({ mintAddress: MINT, verifiedVaultAccounts: vaults }),
    })
    assert.equal(annot.holders[0].classification?.kind, 'liquidity_custody')
    assert.equal(annot.holders[0].classification?.role, 'solana_amm_vault')
    assert.equal(annot.holders[0].percent, 40)
    assert.equal(annot.holders[1].classification?.kind, 'ordinary')
  })

  it('never displays the token-account count as unique holders', () => {
    const r = tallyOf([Array.from({ length: 3 }, () => acct(W1, '1'))], false)
    const counts = buildSolanaHolderCounts({ heliusHolders: { ...r, tokenAccountCount: 3000, holderCount: 3000 }, verifiedVaultAccounts: [], ownerOf: () => null })
    assert.equal(counts.uniqueOwnerCount, null)
    const holderLine = formatSolanaUniqueHolderLine(counts)
    assert.match(holderLine, /^Unique holders unavailable/)
    assert.doesNotMatch(holderLine, /3,?000/)
    assert.equal(formatSolanaTokenAccountLine(counts), '3,000+ token accounts with balance')
    assert.equal(formatSolanaUniqueHolderLine(null), 'Unique holders unavailable')
    assert.equal(formatSolanaTokenAccountLine(null), 'Token accounts with balance unavailable')
  })

  it('UI renders separate holder and token-account lines and no Solana "holders" label for accounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'app/terminal/token-scanner/page.tsx'), 'utf8')
    assert.ok(src.includes('Holder count: {formatSolanaUniqueHolderLine(sr.solanaHolderCounts)}'))
    assert.ok(src.includes('Token accounts: {formatSolanaTokenAccountLine('))
    assert.ok(!/heliusHolders\.isLowerBound \? '\+' : ''\} holders/.test(src))
  })
})

describe('Solana holder counts: bounded pagination, provider calls and cache', () => {
  const saved = { k: process.env.HELIUS_API_KEY, f: process.env.ENABLE_HELIUS_SOLANA }
  beforeEach(() => {
    process.env.HELIUS_API_KEY = 'test'; process.env.ENABLE_HELIUS_SOLANA = 'true'
    __resetMemoryFallbackForTest()
  })
  afterEach(() => {
    if (saved.k === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = saved.k
    if (saved.f === undefined) delete process.env.ENABLE_HELIUS_SOLANA; else process.env.ENABLE_HELIUS_SOLANA = saved.f
    __resetMemoryFallbackForTest()
  })

  // Builds `total` positive accounts spread over `owners` wallets, served 1000 per page.
  function mockHelius(total: number, owners: number, opts: { slot?: number } = {}) {
    let calls = 0
    const rows = Array.from({ length: total }, (_, i) => ({
      address: `Acc${String(i).padStart(40, '0')}`,
      mint: MINT,
      owner: `Own${String(i % owners).padStart(40, '0')}`,
      amount: String(total - i),
    }))
    const impl = (async (_url: string, init?: { body?: string }) => {
      calls++
      const body = JSON.parse(String(init?.body ?? '{}'))
      const page = body.params?.page ?? 1
      const limit = body.params?.limit ?? 1000
      const slice = rows.slice((page - 1) * limit, page * limit)
      return new Response(JSON.stringify({ result: { total: slice.length, limit, page, last_indexed_slot: opts.slot ?? 1, token_accounts: slice } }), { status: 200 })
    }) as unknown as typeof fetch
    return { impl, calls: () => calls }
  }

  const noCache = { cache: null }

  it('<1000 accounts: 1 call, exact owners', async () => {
    const m = mockHelius(742, 300)
    const r = await fetchHeliusHolderCount(MINT, m.impl, noCache)
    assert.equal(m.calls(), 1)
    assert.equal(r.tokenAccountCount, 742)
    assert.equal(r.uniqueOwnerCount, 300)
    assert.equal(r.uniqueOwnerStatus, 'verified')
    assert.equal(r.isLowerBound, false)
  })

  it('3,200 accounts: 4 calls, exact owners (was capped at 3,000+ before)', async () => {
    const m = mockHelius(3200, 2100)
    const r = await fetchHeliusHolderCount(MINT, m.impl, noCache)
    assert.equal(m.calls(), 4)
    assert.equal(r.tokenAccountCount, 3200)
    assert.equal(r.holderCount, 3200)
    assert.equal(r.uniqueOwnerCount, 2100)
    assert.equal(r.uniqueOwnerStatus, 'verified')
  })

  it('8,500 accounts: 9 calls, exact owners', async () => {
    const m = mockHelius(8500, 7000)
    const r = await fetchHeliusHolderCount(MINT, m.impl, noCache)
    assert.equal(m.calls(), 9)
    assert.equal(r.tokenAccountCount, 8500)
    assert.equal(r.uniqueOwnerCount, 7000)
  })

  it('exactly 10,000 accounts cannot be proven complete: 10 calls, cap reached', async () => {
    const m = mockHelius(10000, 9000)
    const r = await fetchHeliusHolderCount(MINT, m.impl, noCache)
    assert.equal(m.calls(), HELIUS_HOLDER_MAX_PAGES)
    assert.equal(r.uniqueOwnerCount, null)
    assert.equal(r.uniqueOwnerReason, SOLANA_UNIQUE_OWNERS_CAP_REACHED_REASON)
  })

  it('>10,000 accounts: hard cap of 10 calls, partial, 10,000+ accounts, no owner estimate', async () => {
    const m = mockHelius(25000, 20000)
    const r = await fetchHeliusHolderCount(MINT, m.impl, noCache)
    assert.equal(m.calls(), 10)
    assert.equal(r.tokenAccountCount, 10000)
    assert.equal(r.isLowerBound, true)
    assert.equal(r.uniqueOwnerCount, null)
    assert.equal(r.uniqueOwnerStatus, 'partial')
    assert.equal(r.uniqueOwnerReason, SOLANA_UNIQUE_OWNERS_CAP_REACHED_REASON)
    const c = buildSolanaHolderCounts({ heliusHolders: r, verifiedVaultAccounts: [], ownerOf: () => null })
    assert.equal(formatSolanaUniqueHolderLine(c), 'Unique holders unavailable')
    assert.equal(formatSolanaTokenAccountLine(c), '10,000+ token accounts with balance')
  })

  it('verified UI wording: N unique owners and M token accounts with balance', async () => {
    const m = mockHelius(3200, 2100)
    const r = await fetchHeliusHolderCount(MINT, m.impl, noCache)
    const c = buildSolanaHolderCounts({ heliusHolders: r, verifiedVaultAccounts: [], ownerOf: (a) => heliusCountedAccountOwner(r, a) })
    assert.equal(formatSolanaUniqueHolderLine(c), '2,100 unique owners')
    assert.equal(formatSolanaTokenAccountLine(c), '3,200 token accounts with balance')
  })

  it('time budget: slow pages stop at the budget as incomplete, uncached, and never verified', async () => {
    assert.ok(HELIUS_HOLDER_TOTAL_BUDGET_MS <= 10_000, 'response-path budget must stay at or under 10s')
    const m = mockHelius(8500, 7000)
    const slow = (async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 60)
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
      })
      return (m.impl as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    const store = new Map<string, unknown>()
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => { store.set(k, v) } }
    const started = Date.now()
    const r = await fetchHeliusHolderCount(MINT, slow, { cache, budgetMs: 150 })
    assert.ok(Date.now() - started < 1000)
    assert.ok(m.calls() >= 1 && m.calls() < 9)
    assert.equal(r.uniqueOwnerStatus, 'partial')
    assert.equal(r.uniqueOwnerCount, null)
    assert.equal(r.uniqueOwnerReason, 'token_account_pagination_incomplete')
    assert.equal(r.isLowerBound, true)
    assert.equal(store.size, 0)
  })

  it('a failed page mid-way is partial (incomplete), never verified', async () => {
    let calls = 0
    const impl = (async (_u: string, init?: { body?: string }) => {
      calls++
      const page = JSON.parse(String(init?.body)).params.page
      if (page === 3) return new Response('boom', { status: 502 })
      const rows = Array.from({ length: 1000 }, (_, i) => acct(`Own${page}${i}`, '1'))
      return new Response(JSON.stringify({ result: { token_accounts: rows } }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await fetchHeliusHolderCount(MINT, impl, noCache)
    assert.equal(calls, 3)
    assert.equal(r.tokenAccountCount, 2000)
    assert.equal(r.uniqueOwnerCount, null)
    assert.equal(r.uniqueOwnerReason, SOLANA_UNIQUE_OWNERS_PAGINATION_INCOMPLETE_REASON)
  })

  it('cache hit avoids repeat pagination (default token cache, exact mint key)', async () => {
    const m = mockHelius(3200, 2100)
    const first = await fetchHeliusHolderCount(MINT, m.impl)
    assert.equal(m.calls(), 4)
    assert.equal(first.ownerCountSource, 'live')
    const second = await fetchHeliusHolderCount(MINT, m.impl)
    assert.equal(m.calls(), 4, 'no new calls on a cache hit')
    assert.equal(second.ownerCountSource, 'cache')
    assert.equal(second.uniqueOwnerCount, 2100)
    assert.equal(second.tokenAccountCount, 3200)
    assert.equal(second.isLowerBound, false)
    assert.equal(second.called, false)
    // A different-case mint is a different mint on Solana: no cross-hit.
    const other = mockHelius(10, 10)
    await fetchHeliusHolderCount(MINT.toLowerCase(), other.impl)
    assert.equal(other.calls(), 1)
    assert.notEqual(solanaOwnerCountCacheKey(MINT), solanaOwnerCountCacheKey(MINT.toLowerCase()))
  })

  it('partial results are never cached', async () => {
    const m = mockHelius(25000, 20000)
    await fetchHeliusHolderCount(MINT, m.impl)
    await fetchHeliusHolderCount(MINT, m.impl)
    assert.equal(m.calls(), 20)
  })

  it('stale evidence never overwrites newer cached evidence', async () => {
    const store = new Map<string, unknown>()
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => { store.set(k, v) } }
    const key = solanaOwnerCountCacheKey(MINT)
    // A concurrent scan stores newer evidence (higher indexed slot) between our cache miss and our write.
    let injected = false
    const newer = { version: 'v1', chainSlug: 'solana', mintAddress: MINT, tokenAccountCount: 999, uniqueOwnerCount: 888, pagesFetched: 1, computedAt: '2030-01-01T00:00:00.000Z', indexedSlot: 500, topAccountOwners: [] }
    const base = mockHelius(742, 300, { slot: 100 })
    const impl = (async (u: string, init?: { body?: string }) => {
      if (!injected) { injected = true; store.set(key, newer) }
      return (base.impl as unknown as (u: string, i?: { body?: string }) => Promise<Response>)(u, init)
    }) as unknown as typeof fetch
    const r = await fetchHeliusHolderCount(MINT, impl, { cache })
    assert.equal(r.uniqueOwnerCount, 300, 'this scan still reports its own live evidence')
    assert.deepEqual(store.get(key), newer, 'older-slot result did not overwrite newer cached evidence')
    assert.equal(ownerCountEvidenceIsNewer({ computedAt: '2026-01-01T00:00:00Z', indexedSlot: 600 }, { computedAt: '2030-01-01T00:00:00Z', indexedSlot: 500 }), true)
    assert.equal(ownerCountEvidenceIsNewer({ computedAt: '2026-01-01T00:00:00Z', indexedSlot: null }, { computedAt: '2026-02-01T00:00:00Z', indexedSlot: null }), false)
  })

  it('cache hit still matches a verified pool vault owner among the largest accounts', async () => {
    const vaultRow = { address: VAULT, mint: MINT, owner: POOL_AUTH, amount: '999999999' }
    const rows = [vaultRow, ...Array.from({ length: 500 }, (_, i) => acct(`Own${i}`, '1'))]
    const impl = (async () => new Response(JSON.stringify({ result: { token_accounts: rows } }), { status: 200 })) as unknown as typeof fetch
    await fetchHeliusHolderCount(MINT, impl)
    const hit = await fetchHeliusHolderCount(MINT, impl)
    assert.equal(hit.ownerCountSource, 'cache')
    assert.equal(heliusOwnerLookupCoversAllAccounts(hit), false)
    const c = buildSolanaHolderCounts({ heliusHolders: hit, verifiedVaultAccounts: [{ address: VAULT }], ownerOf: (a) => heliusCountedAccountOwner(hit, a), ownerLookupComplete: false })
    assert.equal(c.verifiedCustodyOwnerCount, 1)
    const unknownVault = buildSolanaHolderCounts({ heliusHolders: hit, verifiedVaultAccounts: [{ address: 'NotCachedVault11111111111111111111111111111' }], ownerOf: () => null, ownerLookupComplete: false })
    assert.equal(unknownVault.verifiedCustodyOwnerCount, null, 'unresolved vault on a partial lookup is unknown, not 0')
  })

  it('Helius disabled: no calls, both metrics unavailable', async () => {
    delete process.env.HELIUS_API_KEY; delete process.env.ENABLE_HELIUS_SOLANA
    const m = mockHelius(10, 10)
    const r = await fetchHeliusHolderCount(MINT, m.impl)
    assert.equal(m.calls(), 0)
    assert.equal(r.holderCount, null)
    const c = buildSolanaHolderCounts({ heliusHolders: r, verifiedVaultAccounts: [], ownerOf: () => null })
    assert.equal(c.tokenAccountCount, null)
    assert.equal(c.uniqueOwnerStatus, 'unavailable')
  })

  it('merge keeps Top1/10/20 sourcing and risk inputs untouched', () => {
    const merge = fs.readFileSync(path.join(process.cwd(), 'lib/server/solana/providerMerge.ts'), 'utf8')
    assert.ok(merge.includes('top1: holders.topAccountConcentration?.top1Percent ?? null'))
    assert.ok(merge.includes('top10: holders.topAccountConcentration?.top10Percent ?? null'))
    assert.ok(merge.includes('top20: holders.topAccountConcentration?.top20Percent ?? null'))
    const risk = fs.readFileSync(path.join(process.cwd(), 'lib/solanaCortexRisk.ts'), 'utf8')
    assert.ok(!risk.includes('uniqueOwnerCount') && !risk.includes('solanaHolderCounts'), 'risk does not read the new fields')
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/server/solanaProviders.ts'), 'utf8')
    assert.ok(src.includes('export const HELIUS_HOLDER_MAX_PAGES = 10'))
    assert.ok(/for \(let page = 1; page <= HELIUS_HOLDER_MAX_PAGES; page\+\+\)/.test(src), 'loop is bounded by the page cap')
  })
})
