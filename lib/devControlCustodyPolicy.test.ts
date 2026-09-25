/**
 * Dev Control × liquidity-custody policy regressions.
 * Run: node --import tsx --test lib/devControlCustodyPolicy.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  partitionLinkedWalletsForDevSupply,
  reconcileDevClusterAuditWithCustody,
} from './devControlCustodyPolicy'
import {
  annotateLiquidityCustody,
  buildEvmCustodyCandidates,
  computeOrdinaryConcentration,
  ROBINHOOD_V4_POOL_MANAGER_ADDRESS,
} from './liquidityCustody'
import { clusterSupplyFromHolders, emptyDevClusterDiagnosisAudit } from './devClusterDiagnosis'
import { buildClusterMap } from './clusterMap'

// ASTEROID / Ethereum fixture (live observation 2026-09-25).
const ASTEROID = '0xaff2565091e7207191dbe340b8528d02fa78d044'
const ASTEROID_POOL = '0x7dfc9dd51638573a812b39d33eded20df468e7bc'
const DEPLOYER = '0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0'
const TEAM_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_HOLDER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function holders(rows: Array<{ address: string; percent: number }>) {
  return rows.map((r, i) => ({ rank: i + 1, address: r.address, amount: '0', percent: r.percent }))
}

function asteroidHolderRows() {
  const candidates = buildEvmCustodyCandidates({
    chain: 'eth',
    tokenAddress: ASTEROID,
    pools: [{ address: ASTEROID_POOL, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap_v2' }],
  })
  return annotateLiquidityCustody({
    chain: 'eth',
    holders: holders([
      { address: ASTEROID_POOL, percent: 10.31 },
      { address: TEAM_WALLET, percent: 3 },
      { address: OTHER_HOLDER, percent: 2 },
    ]),
    candidates,
  }).holders
}

/** Mirrors the /api/token supplyControl loop: linked supply = sum of matched linked holder percents. */
function linkedSupply(rows: Array<{ address: string; percent: number | null }>, linked: Array<{ address: string }>): number | null {
  const set = new Set(linked.map((w) => w.address.toLowerCase()))
  const matched = rows.filter((r) => set.has(r.address.toLowerCase()) && r.percent != null)
  return matched.length ? Math.round(matched.reduce((s, r) => s + (r.percent ?? 0), 0) * 100) / 100 : null
}

describe('1. ASTEROID: verified V2 pool linked only by first_token_receiver_from_origin', () => {
  it('is excluded from ordinary linked-wallet and dev-cluster supply, and reported separately', () => {
    const rows = asteroidHolderRows()
    assert.equal(rows[0].classification?.kind, 'liquidity_custody')
    assert.equal(rows[0].classification?.role, 'amm_pool_reserves')
    const linked = [{ address: ASTEROID_POOL, reason: 'first_token_receiver_from_origin', confidence: 'medium' }]

    // Before: the pool counted as a linked dev wallet.
    assert.equal(linkedSupply(rows, linked), 10.31)
    assert.equal(clusterSupplyFromHolders(rows, DEPLOYER, linked), 10.31)

    const { countable, custodyExcluded } = partitionLinkedWalletsForDevSupply({ linkedWallets: linked, holderRows: rows })
    assert.deepEqual(countable, [])
    assert.equal(custodyExcluded.length, 1)
    assert.equal(custodyExcluded[0].address, ASTEROID_POOL)
    assert.equal(custodyExcluded[0].custodyRole, 'amm_pool_reserves')
    assert.equal(custodyExcluded[0].linkReason, 'first_token_receiver_from_origin')
    assert.equal(custodyExcluded[0].percent, 10.31)
    assert.equal(custodyExcluded[0].excludedFromDevSupply, true)

    // After: no linked supply, dev cluster = creator only (deployer not a top holder).
    assert.equal(linkedSupply(rows, countable), null)
    assert.equal(clusterSupplyFromHolders(rows, DEPLOYER, countable), null)
  })

  it('token_supply_transfer (ETH origin discovery) and top_holder_direct_transfer are also seeding-only', () => {
    const rows = asteroidHolderRows()
    for (const reason of ['token_supply_transfer', 'top_holder_direct_transfer']) {
      const r = partitionLinkedWalletsForDevSupply({ linkedWallets: [{ address: ASTEROID_POOL.toUpperCase().replace('0X', '0x'), reason }], holderRows: rows })
      assert.equal(r.countable.length, 0, reason)
      assert.equal(r.custodyExcluded.length, 1, reason)
    }
  })
})

describe('2. Same custody address with independent dev-control evidence', () => {
  it('keeps the address counted but flags it as custody, not silently dropped', () => {
    const rows = asteroidHolderRows()
    for (const reason of ['admin_or_proxy_control_wallet', 'funded_by_origin', 'eth_funding_transfer']) {
      const { countable, custodyExcluded } = partitionLinkedWalletsForDevSupply({
        linkedWallets: [
          { address: ASTEROID_POOL, reason: 'first_token_receiver_from_origin' },
          { address: ASTEROID_POOL, reason },
        ],
        holderRows: rows,
      })
      assert.equal(custodyExcluded.length, 0, reason)
      assert.ok(countable.length >= 1, reason)
      assert.ok(countable.every((w) => w.liquidityCustodyRole === 'amm_pool_reserves'), reason)
      assert.ok(countable.every((w) => w.devControlBasis === 'independent_dev_evidence_on_liquidity_custody_address'), reason)
      assert.equal(linkedSupply(rows, countable), 10.31, reason)
    }
  })
})

describe('3. Robinhood V4 PoolManager', () => {
  it('never becomes a linked dev wallet from token custody alone', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: ASTEROID,
      pools: [{ address: null, poolId: '0x' + 'cd'.repeat(32), poolAddressType: 'pool_id', poolType: 'concentrated', dexId: 'uniswap_v4', dexName: 'Uniswap V4' }],
    })
    const rows = annotateLiquidityCustody({
      chain: 'robinhood',
      holders: holders([{ address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS, percent: 55 }, { address: TEAM_WALLET, percent: 2 }]),
      candidates,
    }).holders
    assert.equal(rows[0].classification?.role, 'v4_pool_manager')
    for (const reason of ['first_token_receiver_from_origin', 'token_supply_transfer', 'top_holder_direct_transfer']) {
      const { countable, custodyExcluded } = partitionLinkedWalletsForDevSupply({
        linkedWallets: [{ address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS, reason }],
        holderRows: rows,
      })
      assert.equal(countable.length, 0, reason)
      assert.equal(custodyExcluded[0].custodyRole, 'v4_pool_manager', reason)
    }
  })

  it('PoolManager without a verified V4 pool for this token stays unknown (not excluded)', () => {
    const rows = annotateLiquidityCustody({
      chain: 'robinhood',
      holders: holders([{ address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS, percent: 55 }]),
      candidates: [],
    }).holders
    assert.notEqual(rows[0].classification?.kind, 'liquidity_custody')
    const r = partitionLinkedWalletsForDevSupply({ linkedWallets: [{ address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS, reason: 'first_token_receiver_from_origin' }], holderRows: rows })
    assert.equal(r.countable.length, 1)
    assert.equal(r.custodyExcluded.length, 0)
  })
})

describe('4. Ordinary first receiver still counts', () => {
  it('ordinary wallet and unclassified contract receivers are counted as before', () => {
    const rows = asteroidHolderRows()
    const linked = [
      { address: ASTEROID_POOL, reason: 'first_token_receiver_from_origin' },
      { address: TEAM_WALLET, reason: 'first_token_receiver_from_origin' },
      { address: OTHER_HOLDER, reason: 'first_token_receiver_from_origin' },
    ]
    const { countable } = partitionLinkedWalletsForDevSupply({ linkedWallets: linked, holderRows: rows })
    assert.deepEqual(countable.map((w) => w.address), [TEAM_WALLET, OTHER_HOLDER])
    assert.ok(countable.every((w) => w.liquidityCustodyRole === undefined))
    assert.equal(linkedSupply(rows, countable), 5)
  })

  it('no custody rows: identity pass-through', () => {
    const plain = holders([{ address: TEAM_WALLET, percent: 3 }])
    const linked = [{ address: TEAM_WALLET, reason: 'first_token_receiver_from_origin' }]
    const r = partitionLinkedWalletsForDevSupply({ linkedWallets: linked, holderRows: plain })
    assert.deepEqual(r.countable, linked)
    assert.deepEqual(r.custodyExcluded, [])
  })
})

describe('5. linkedWalletSupply / devClusterSupply / clusterRisk update only when justified', () => {
  const baseAudit = () => {
    const a = emptyDevClusterDiagnosisAudit(1, 'eth', ASTEROID)
    a.linkedWalletGraph = { ...a.linkedWalletGraph, attempted: true, graphStatus: 'ran_found', walletsMapped: 1, linkedWalletSupplyPct: 10.31, confidence: 'medium', failureReason: null }
    return a
  }

  it('audit is returned unchanged (same object) when nothing was excluded', () => {
    const a = baseAudit()
    assert.equal(reconcileDevClusterAuditWithCustody(a, { custodyExcludedCount: 0, countableLinkedCount: 1, devClusterSupplyPercent: 10.31 }), a)
  })

  it('audit aligned to canonical supply without mutating the (cached) input', () => {
    const a = baseAudit()
    const next = reconcileDevClusterAuditWithCustody(a, { custodyExcludedCount: 1, countableLinkedCount: 0, devClusterSupplyPercent: null })
    assert.notEqual(next, a)
    assert.equal(a.linkedWalletGraph.linkedWalletSupplyPct, 10.31)
    assert.equal(next.linkedWalletGraph.linkedWalletSupplyPct, null)
    assert.equal(next.linkedWalletGraph.walletsMapped, 0)
    assert.equal(next.linkedWalletGraph.graphStatus, 'ran_none')
    assert.equal(next.linkedWalletGraph.liquidityCustodyExcluded, 1)
  })

  it('cluster risk drops for ASTEROID once the pool is no longer dev-cluster supply; direction canonical', () => {
    const rows = asteroidHolderRows()
    const common = { deployerAddress: DEPLOYER, holderDistribution: { topHolders: rows }, holderRowsAvailable: true }
    const before = buildClusterMap({
      ...common,
      linkedWallets: [{ address: ASTEROID_POOL, reason: 'first_token_receiver_from_origin', confidence: 'medium' }],
      matchedLinkedWallets: [{ address: ASTEROID_POOL, percent: 10.31, rank: 1, confidence: 'medium' }],
      supplyControl: { linkedWalletSupplyPercent: 10.31, devClusterSupplyPercent: 10.31, devClusterSupplyStatus: 'verified' },
    } as Parameters<typeof buildClusterMap>[0])
    const after = buildClusterMap({
      ...common,
      linkedWallets: [],
      matchedLinkedWallets: [],
      supplyControl: { linkedWalletSupplyPercent: 0, devClusterSupplyPercent: 0, devClusterSupplyStatus: 'verified' },
    } as Parameters<typeof buildClusterMap>[0])
    const b = before.summary.clusterRiskScore
    const a = after.summary.clusterRiskScore
    assert.equal(typeof b, 'number')
    assert.equal(typeof a, 'number')
    assert.ok((a as number) < (b as number), `expected lower risk after (${a}) than before (${b})`)
    assert.ok(!after.nodes.some((n) => n.address === ASTEROID_POOL && n.type === 'linked_wallet'))
  })
})

describe('6. Stage 1/2 custody + ordinary concentration unchanged by the policy', () => {
  it('partition does not mutate holder rows or their classification', () => {
    const rows = asteroidHolderRows()
    const snapshot = JSON.stringify(rows)
    const concBefore = computeOrdinaryConcentration({ holders: rows, totalSupplyKnown: true, holderCount: 3 } as Parameters<typeof computeOrdinaryConcentration>[0])
    partitionLinkedWalletsForDevSupply({ linkedWallets: [{ address: ASTEROID_POOL, reason: 'first_token_receiver_from_origin' }], holderRows: rows })
    assert.equal(JSON.stringify(rows), snapshot)
    const concAfter = computeOrdinaryConcentration({ holders: rows, totalSupplyKnown: true, holderCount: 3 } as Parameters<typeof computeOrdinaryConcentration>[0])
    assert.deepEqual(concAfter, concBefore)
  })
})

describe('7/8. Route wiring: placement and untouched surfaces', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/token/route.ts'), 'utf8')
  it('partition runs after Stage-1 custody annotation and before linked supply matching', () => {
    const annot = route.indexOf('annotateLiquidityCustody(')
    const part = route.indexOf('partitionLinkedWalletsForDevSupply({ linkedWallets, holderRows })')
    const set = route.indexOf('const linkedAddressSet = new Set(linkedWallets.map')
    const reconcile = route.indexOf('reconcileDevClusterAuditWithCustody(devClusterDiagnosisAudit')
    const map = route.indexOf('const clusterMap = buildClusterMap(')
    assert.ok(annot > 0 && part > annot, 'partition after annotation')
    assert.ok(set > part, 'partition before linkedAddressSet')
    assert.ok(reconcile > set && map > reconcile, 'audit reconciled before cluster map')
  })
  it('policy module is pure (no fetch / provider calls) and does not read LP Safety or holder count', () => {
    const src = readFileSync(join(process.cwd(), 'lib/devControlCustodyPolicy.ts'), 'utf8')
    assert.ok(!/fetch\(|goldrush|moralis|alchemy|blockscout|process\.env/i.test(src.replace(/\/\/.*$/gm, '')))
    assert.ok(!/lpSafety|holderCount|lpControl|lpLock/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
  })
})
