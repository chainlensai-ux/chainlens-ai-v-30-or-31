// Cross-chain Token Scanner holder integrity (eth, base, bnb, robinhood, solana).
// Guards the class of bug where bounded, transfer-derived or sample-derived holder evidence
// became public concentration, holder count, Stage 1/2 custody, Dev Control supply or risk.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  HOLDER_PERCENT_NO_TOTAL_SUPPLY_REASON,
  TRANSFER_DERIVED_NOT_CURRENT_REASON,
  mergeDevClusterOverlayHolders,
  resolveHolderCountSemantics,
  selectHolderPercentDenominator,
} from '../lib/holderFallbackPolicy'
import { formatHolderCountDisplay, holderCountProvenance } from '../lib/tokenScannerHolderCount'
import {
  ORDINARY_PERCENTAGES_UNAVAILABLE_REASON,
  ROBINHOOD_V4_POOL_MANAGER_ADDRESS,
  annotateLiquidityCustody,
  buildEvmCustodyCandidates,
  buildSolanaCustodyCandidates,
  computeOrdinaryConcentration,
} from '../lib/liquidityCustody'
import { partitionLinkedWalletsForDevSupply } from '../lib/devControlCustodyPolicy'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
const ROUTE = read('app/api/token/route.ts')

// ASTEROID (eth) live shape, 2026-09-25: 1B supply (18 decimals), pool 0x7dfc… holds ~6.93%.
const E18 = BigInt(10) ** BigInt(18)
const ASTEROID_SUPPLY = BigInt(1_000_000_000) * E18
const ASTEROID = '0xaff2565091e7207191dbe340b8528d02fa78d044'
const ASTEROID_POOL = '0x7dfc9dd51638573a812b39d33eded20df468e7bc'
const pctOf = (raw: bigint, supply: bigint) => Number((raw * BigInt(10) ** BigInt(8)) / supply) / 1e6

function asteroidRows(withPct: boolean) {
  const raws: bigint[] = [ASTEROID_SUPPLY * BigInt(693) / BigInt(10000)]
  for (let i = 0; i < 19; i++) raws.push(ASTEROID_SUPPLY * BigInt(200 - i * 5) / BigInt(10000))
  return raws.map((raw, i) => ({
    rank: i + 1,
    address: i === 0 ? ASTEROID_POOL : `0x${(i + 1).toString(16).padStart(40, '0')}`,
    amount: raw.toString(),
    percent: withPct ? pctOf(raw, ASTEROID_SUPPLY) : null,
  }))
}
const sumTop = (rows: Array<{ percent: number | null }>, n: number) => rows.slice(0, n).reduce((s, r) => s + (r.percent ?? 0), 0)

describe('no sample-sum denominator', () => {
  it('prefers RPC supply, then provider total_supply, and never a sum of returned rows', () => {
    assert.deepEqual(selectHolderPercentDenominator({ rpcOnchainTotalSupply: BigInt(5), rpcPhase1TotalSupplyHex: '0x09', providerTotalSupplyRaw: '7' }), { totalSupply: BigInt(5), source: 'rpc_onchain' })
    assert.deepEqual(selectHolderPercentDenominator({ rpcPhase1TotalSupplyHex: '0x09', providerTotalSupplyRaw: '7' }), { totalSupply: BigInt(9), source: 'rpc_phase1' })
    assert.deepEqual(selectHolderPercentDenominator({ rpcPhase1TotalSupplyHex: '0x', providerTotalSupplyRaw: ASTEROID_SUPPLY.toString() }), { totalSupply: ASTEROID_SUPPLY, source: 'provider_total_supply' })
    assert.equal(selectHolderPercentDenominator({ rpcOnchainTotalSupply: null, rpcPhase1TotalSupplyHex: '0x0', providerTotalSupplyRaw: '0' }), null)
    assert.equal(selectHolderPercentDenominator({ providerTotalSupplyRaw: 'not-a-number' }), null)
  })

  it('ASTEROID: real supply keeps pool at ~6.93%; a sample-sum would have inflated it', () => {
    const rows = asteroidRows(false)
    const sampleSum = rows.reduce((s, r) => s + BigInt(r.amount), BigInt(0))
    const denom = selectHolderPercentDenominator({ providerTotalSupplyRaw: ASTEROID_SUPPLY.toString() })!
    assert.equal(pctOf(BigInt(rows[0].amount), denom.totalSupply), 6.93)
    assert.ok(pctOf(BigInt(rows[0].amount), sampleSum) > 12, 'sample-sum would publish >12%')
  })

  it('route: both percentage paths use the real-supply selector; summed denominators are gone', () => {
    assert.ok(ROUTE.includes('selectHolderPercentDenominator({'))
    assert.ok(ROUTE.includes('HOLDER_PERCENT_NO_TOTAL_SUPPLY_REASON'))
    for (const banned of ['_summedBalanceSupply', 'holder_percentages_derived_from_summed_balances', 'percentages_estimated_from_returned_rows', '_holderPctDerivedFromSummedRows']) {
      assert.ok(!ROUTE.includes(banned), `route still contains ${banned}`)
    }
    assert.equal(HOLDER_PERCENT_NO_TOTAL_SUPPLY_REASON, 'holder_percentages_unavailable_no_total_supply')
  })
})

describe('holder count: row count is never an exact total', () => {
  it('bounded top-holder page never becomes holder count', () => {
    for (const rows of [50, 99, 100, 200]) {
      const s = resolveHolderCountSemantics({ providerTotal: null, normalizedRows: rows, resolverRows: rows })
      assert.equal(s.holderCount, null)
      assert.equal(s.holderCountExact, false)
      assert.equal(s.holderCountCapped, true)
      assert.notEqual(s.holderCountReason, 'holder_count_from_provider_total')
      const d = formatHolderCountDisplay({ holderCount: s.holderCount, holderCountReason: s.holderCountReason, isCapped: s.holderCountCapped, holderRowsReturned: rows })
      assert.equal(d.exact, false)
    }
  })
  it('provider total is kept separate from returned sample size', () => {
    const s = resolveHolderCountSemantics({ providerTotal: 3545, normalizedRows: 100, resolverRows: 200 })
    assert.equal(s.holderCount, 3545)
    assert.equal(s.holderCountExact, true)
    assert.equal(s.holderCountReason, 'holder_count_from_provider_total')
  })
})

describe('chain-specific holder provenance', () => {
  it('GoldRush slugs per chain are unchanged', () => {
    assert.ok(ROUTE.includes("eth: ['eth-mainnet']"))
    assert.ok(ROUTE.includes("base: ['base-mainnet']"))
    assert.ok(ROUTE.includes("bnb: ['bsc-mainnet']"))
    assert.ok(ROUTE.includes("robinhood: ['robinhood-mainnet', '4663']"))
  })
  it('basis: eth/base/bnb documented, robinhood undocumented, moralis unverified', () => {
    for (const id of ['eth-mainnet', 'base-mainnet', 'bsc-mainnet']) {
      assert.equal(holderCountProvenance({ data: { pagination: { total_count: 10 } }, __chainUsed: id }, null).holderCountBasis, 'provider_total_supported_chain')
    }
    for (const id of ['robinhood-mainnet', '4663']) {
      const p = holderCountProvenance({ data: { pagination: { total_count: 374 } }, __chainUsed: id }, null)
      assert.equal(p.holderCountBasis, 'provider_total_unsupported_chain')
      assert.equal(p.providerTotal, 374)
    }
    assert.equal(holderCountProvenance(null, { total: 99 }).holderCountBasis, 'provider_total_support_unverified')
    assert.equal(holderCountProvenance(null, null).provider, null)
  })
})

describe('no transfer-derived promotion / no weaker overwrite', () => {
  const base = (rows: ReturnType<typeof asteroidRows>) => ({
    holderRows: rows,
    holderDistribution: { top1: rows[0].percent, top10: rows[0].percent == null ? null : sumTop(rows, 10), top20: rows[0].percent == null ? null : sumTop(rows, 20), others: null, topHolders: rows },
    holderDistributionStatus: { status: 'ok', reason: 'ok', itemCount: rows.length, normalizedCount: rows.length, percentSource: 'calculated' },
  })
  const launch = { holders: [{ address: '0xdeployer', percent: 61.82 }], holdersSource: 'transfer_derived', top1Pct: 61.82, top10Pct: 99, top20Pct: 100 }

  it('launch replay never replaces valid current rows', () => {
    const rows = asteroidRows(true)
    const r = mergeDevClusterOverlayHolders({ ...base(rows), overlay: launch, transferDerivedAvailable: true })
    assert.equal(r.transferDerivedRejected, true)
    assert.equal(r.holderDistribution.top1, 6.93)
    assert.equal(r.holderRows, rows)
  })
  it('launch replay never fills rows lacking percentages', () => {
    const rows = asteroidRows(false)
    const r = mergeDevClusterOverlayHolders({ ...base(rows), overlay: launch, transferDerivedAvailable: true })
    assert.equal(r.holderDistribution.top1, null)
    assert.equal(r.holderDistributionStatus.status, 'partial')
    assert.equal(r.holderDistributionStatus.reason, TRANSFER_DERIVED_NOT_CURRENT_REASON)
  })
  it('a current overlay cannot overwrite rows that already carry real percentages', () => {
    const rows = asteroidRows(true)
    const r = mergeDevClusterOverlayHolders({
      ...base(rows),
      overlay: { holders: [{ address: '0xother', percent: 40 }], holdersSource: 'goldrush', top1Pct: 40, top10Pct: 80, top20Pct: 90 },
    })
    assert.equal(r.holderRows, rows)
    assert.equal(r.holderDistribution.top1, 6.93)
    assert.equal(r.holderDistributionStatus.status, 'ok')
  })
})

describe('Stage 1/2 invariance', () => {
  const evmChains = ['eth', 'base', 'bnb'] as const
  it('EVM: verified pool annotated, percents and total Top-N unchanged, ordinary excludes only custody', () => {
    for (const chain of evmChains) {
      const rows = asteroidRows(true)
      const before = rows.map((r) => r.percent)
      const ann = annotateLiquidityCustody({ chain, holders: rows, candidates: buildEvmCustodyCandidates({ chain, tokenAddress: ASTEROID, pools: [{ address: ASTEROID_POOL, poolAddressType: 'contract', poolType: chain === 'base' ? 'v3' : 'v2' }] }) })
      assert.deepEqual(ann.holders.map((h) => h.percent), before)
      assert.equal(ann.holders[0].classification?.kind, 'liquidity_custody')
      const ord = computeOrdinaryConcentration({ holders: ann.holders, requestedDepth: 10 })
      assert.equal(ord.totalTop10, sumTop(rows, 10))
      assert.equal(ord.ordinaryCoverage.status, 'verified')
      assert.ok(Math.abs((ord.ordinaryTop10 ?? 0) - sumTop(rows.slice(1), 10)) < 1e-9)
    }
  })
  it('pool without explicit contract type is never custody', () => {
    const rows = asteroidRows(true)
    const ann = annotateLiquidityCustody({ chain: 'base', holders: rows, candidates: buildEvmCustodyCandidates({ chain: 'base', tokenAddress: ASTEROID, pools: [{ address: ASTEROID_POOL, poolType: 'v2' }] }) })
    assert.equal(ann.holders.some((h) => h.classification?.kind === 'liquidity_custody'), false)
  })
  it('Robinhood V4 PoolManager is custody only with an exact bytes32 poolId', () => {
    const rows = [{ rank: 1, address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS, percent: 9 }, { rank: 2, address: '0x' + '1'.repeat(40), percent: 2 }]
    const withId = annotateLiquidityCustody({ chain: 'robinhood', holders: rows, candidates: buildEvmCustodyCandidates({ chain: 'robinhood', tokenAddress: ASTEROID, pools: [{ address: null, poolId: '0x' + 'ab'.repeat(32), poolType: 'uniswap_v4' }] }) })
    assert.equal(withId.holders[0].classification?.kind, 'liquidity_custody')
    const noId = annotateLiquidityCustody({ chain: 'robinhood', holders: rows, candidates: buildEvmCustodyCandidates({ chain: 'robinhood', tokenAddress: ASTEROID, pools: [{ address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS, poolType: 'uniswap_v4', dexId: 'uniswap-v4' }] }) })
    assert.equal(noId.holders.some((h) => h.classification?.kind === 'liquidity_custody'), false)
  })
  it('rows without real-supply percentages never publish a verified ordinary 0%', () => {
    for (const chain of [...evmChains, 'robinhood'] as const) {
      const rows = asteroidRows(false)
      const ann = annotateLiquidityCustody({ chain, holders: rows, candidates: buildEvmCustodyCandidates({ chain, tokenAddress: ASTEROID, pools: [{ address: ASTEROID_POOL, poolAddressType: 'contract', poolType: 'v2' }] }) })
      const ord = computeOrdinaryConcentration({ holders: ann.holders, requestedDepth: 10 })
      assert.equal(ord.ordinaryTop10, null)
      assert.equal(ord.ordinaryTop1, null)
      assert.equal(ord.ordinaryCoverage.status, 'not_computed')
      assert.equal(ord.ordinaryCoverage.reason, ORDINARY_PERCENTAGES_UNAVAILABLE_REASON)
    }
  })
})

describe('Solana token-account semantics', () => {
  const MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'
  const VAULT = 'Vau1t11111111111111111111111111111111111111'
  const accounts = [VAULT, ...Array.from({ length: 19 }, (_, i) => `Acct${String(i).padStart(3, '0')}1111111111111111111111111111111111`)]
    .map((address, i) => ({ rank: i + 1, address, percent: i === 0 ? 5 : 3 - i * 0.1 }))

  it('ordinary series needs verified vault evidence', () => {
    const none = annotateLiquidityCustody({ chain: 'solana', holders: accounts, candidates: buildSolanaCustodyCandidates({ mintAddress: MINT, verifiedVaultAccounts: [] }) })
    assert.equal(none.holders.some((h) => h.classification?.kind === 'liquidity_custody'), false)
    const ordNone = computeOrdinaryConcentration({ holders: none.holders, requestedDepth: 10, custodyEvidenceAvailable: false })
    assert.equal(ordNone.ordinaryTop10, null)
    assert.equal(ordNone.ordinaryCoverage.status, 'not_computed')

    const vaults = [{ address: VAULT, poolRef: 'pool', evidence: ['lp_vault_owner_equals_verified_pool'] }]
    const withV = annotateLiquidityCustody({ chain: 'solana', holders: accounts, candidates: buildSolanaCustodyCandidates({ mintAddress: MINT, verifiedVaultAccounts: vaults }) })
    assert.equal(withV.holders[0].classification?.kind, 'liquidity_custody')
    const ord = computeOrdinaryConcentration({ holders: withV.holders, requestedDepth: 10, custodyEvidenceAvailable: true })
    assert.equal(ord.ordinaryCoverage.status, 'verified')
    assert.equal(ord.totalTop10, sumTop(accounts, 10))
  })
  it('unknown mint supply: vault evidence alone cannot produce a verified ordinary series', () => {
    const noPct = accounts.map((a) => ({ ...a, percent: null }))
    const ann = annotateLiquidityCustody({ chain: 'solana', holders: noPct, candidates: buildSolanaCustodyCandidates({ mintAddress: MINT, verifiedVaultAccounts: [{ address: VAULT }] }) })
    const ord = computeOrdinaryConcentration({ holders: ann.holders, requestedDepth: 10, custodyEvidenceAvailable: true })
    assert.equal(ord.ordinaryTop10, null)
    assert.equal(ord.ordinaryCoverage.status, 'not_computed')
  })
  it('concentration divides only by mint supply; count is labeled token accounts', () => {
    const resolver = read('lib/server/solana/holderConcentrationResolver.ts')
    assert.match(resolver, /function computeConcentration\([\s\S]*?rawSupplyExact[\s\S]*?rawSupplyBig != null && rawSupplyBig > ZERO/)
    assert.ok(!/transfer_derived|transferDerived/.test(resolver), 'no EVM transfer-derived path in Solana resolver')
    const page = read('app/terminal/token-scanner/page.tsx')
    assert.ok(page.includes('Token accounts with balance'))
    assert.ok(page.includes('these are token accounts, not resolved unique holders'))
  })
})

describe('Dev Control / risk invariance on valid holder evidence', () => {
  it('seeding-only pool link is excluded from dev supply; real dev wallet still counts', () => {
    const rows = asteroidRows(true)
    const ann = annotateLiquidityCustody({ chain: 'eth', holders: rows, candidates: buildEvmCustodyCandidates({ chain: 'eth', tokenAddress: ASTEROID, pools: [{ address: ASTEROID_POOL, poolAddressType: 'contract', poolType: 'v2' }] }) })
    const dev = rows[3].address
    const part = partitionLinkedWalletsForDevSupply({
      linkedWallets: [{ address: ASTEROID_POOL, reason: 'first_token_receiver_from_origin' }, { address: dev, reason: 'funded_by_deployer' }],
      holderRows: ann.holders,
    })
    assert.deepEqual(part.custodyExcluded.map((c) => c.address.toLowerCase()), [ASTEROID_POOL])
    assert.deepEqual(part.countable.map((w) => w.address), [dev])
  })
  it('no custody rows: Dev Control input passes through unchanged', () => {
    const linked = [{ address: '0xabc', reason: 'first_token_receiver_from_origin' }]
    const part = partitionLinkedWalletsForDevSupply({ linkedWallets: linked, holderRows: asteroidRows(true) })
    assert.deepEqual(part.countable, linked)
    assert.deepEqual(part.custodyExcluded, [])
  })
  it('risk/Dev Control keep reading the legacy total-supply series, not ordinary', () => {
    assert.ok(ROUTE.includes('Risk / Dev Control'))
    assert.ok(!/riskEngine[^\n]*ordinaryTop/.test(ROUTE))
    assert.ok(!/devControl[^\n]*ordinaryTop/i.test(ROUTE))
  })
})
