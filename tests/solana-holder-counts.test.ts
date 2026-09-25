import { describe, it, afterEach } from 'node:test'
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
} from '../lib/server/solanaProviders'
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
  const t = { accountOwner: new Map<string, string | null>(), pagesFetched: 0 }
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
    assert.match(formatSolanaUniqueHolderLine(counts), /^3 wallets \(includes 1 verified pool vault authority\)$/)
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

describe('Solana holder counts: provider calls and legacy fields', () => {
  const saved = { k: process.env.HELIUS_API_KEY, f: process.env.ENABLE_HELIUS_SOLANA }
  afterEach(() => {
    if (saved.k === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = saved.k
    if (saved.f === undefined) delete process.env.ENABLE_HELIUS_SOLANA; else process.env.ENABLE_HELIUS_SOLANA = saved.f
  })

  function mockFetch(pages: unknown[][]) {
    let calls = 0
    const impl = (async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      calls++
      const page = pages[(body.params?.page ?? 1) - 1] ?? []
      return new Response(JSON.stringify({ result: { token_accounts: page } }), { status: 200 })
    }) as unknown as typeof fetch
    return { impl, calls: () => calls }
  }

  it('short first page: 1 call, complete, unique owners verified', async () => {
    process.env.HELIUS_API_KEY = 'test'; process.env.ENABLE_HELIUS_SOLANA = 'true'
    const m = mockFetch([[acct(W1, '1'), acct(W1, '2'), acct(W2, '3')]])
    const r = await fetchHeliusHolderCount(MINT, m.impl)
    assert.equal(m.calls(), 1)
    assert.equal(r.holderCount, 3)
    assert.equal(r.isLowerBound, false)
    assert.equal(r.uniqueOwnerCount, 2)
  })

  it('page cap: still exactly 3 calls, legacy 3000 lower bound unchanged, unique owners partial', async () => {
    process.env.HELIUS_API_KEY = 'test'; process.env.ENABLE_HELIUS_SOLANA = 'true'
    const full = () => Array.from({ length: 1000 }, (_, i) => acct(i % 2 ? W1 : W2, '1'))
    const m = mockFetch([full(), full(), full(), full()])
    const r = await fetchHeliusHolderCount(MINT, m.impl)
    assert.equal(m.calls(), 3)
    assert.equal(r.holderCount, 3000)
    assert.equal(r.isLowerBound, true)
    assert.equal(r.pagesFetched, 3)
    assert.equal(r.uniqueOwnerCount, null)
    assert.equal(r.uniqueOwnerStatus, 'partial')
  })

  it('Helius disabled: no calls, both metrics unavailable', async () => {
    delete process.env.HELIUS_API_KEY; delete process.env.ENABLE_HELIUS_SOLANA
    const m = mockFetch([])
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
  })
})
