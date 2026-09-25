/**
 * Holder fallback regression: transfer-derived launch rows must never become public holder evidence.
 * Fixture: ASTEROID/ETH earliest 50 token transfers (Blockscout, fetched 2026-09-25).
 * Run: node --import tsx --test lib/holderFallbackPolicy.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mergeDevClusterOverlayHolders,
  resolveHolderCountSemantics,
  rpcSupplyToDecimal,
  TRANSFER_DERIVED_NOT_CURRENT_REASON,
} from './holderFallbackPolicy'
import { clusterSupplyFromHolders, deriveHolderConcentrationFromTransfers, type DevClusterTransfer } from './devClusterDiagnosis'
import { resolveDevClusterDiagnosis } from './server/devClusterDiagnosis'
import { annotateLiquidityCustody, buildEvmCustodyCandidates, computeOrdinaryConcentration } from './liquidityCustody'
import { formatHolderCountDisplay } from './tokenScannerHolderCount'

const ASTEROID = '0xaff2565091e7207191dbe340b8528d02fa78d044'
const POOL = '0x7dfc9dd51638573a812b39d33eded20df468e7bc'
const DEPLOYER = '0xe843439d8c0917961aa7076e2f8b25c6d1b92778'
const SUPPLY_1B = '1000000000000000000000000000'
const LAUNCH: DevClusterTransfer[] = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/asteroid-eth-launch-transfers.json'), 'utf8'),
).map((t: DevClusterTransfer) => ({ ...t, category: 'erc20' }))

type Row = { rank: number; address: string; amount: string | number | null; percent: number | null }
function baseDist(rows: Row[], holderCount: number | null) {
  return { top1: null as number | null, top10: null as number | null, top20: null as number | null, others: null as number | null, holderCount, topHolders: rows }
}
const pctlessRows: Row[] = [
  { rank: 1, address: POOL, amount: '68700000000000000000000000', percent: null },
  { rank: 2, address: '0x1111111111111111111111111111111111111111', amount: '10', percent: null },
]
const partialStatus = { status: 'partial', reason: 'holder_percentages_unavailable', itemCount: 2, normalizedCount: 2, percentSource: 'inferred' }

async function overlayFromLaunch(totalSupplyRaw: string | null, holdersIn: Array<{ address: string; percent: number | null }> = []) {
  return resolveDevClusterDiagnosis({
    chainSlug: 'eth', chainId: 1, tokenAddress: ASTEROID, skipNetwork: true,
    existing: { deployerAddress: DEPLOYER, deployerStatus: 'confirmed', holders: holdersIn, transfers: LAUNCH, totalSupplyRaw },
  })
}

describe('ASTEROID launch-transfer fixture', () => {
  it('reproduces the bad live numbers when replayed directly (pinned root cause)', () => {
    const d = deriveHolderConcentrationFromTransfers(LAUNCH, ASTEROID, null)!
    assert.equal(d.rows[0].address, POOL)
    assert.equal(d.top1Pct, 61.82)
    assert.equal(d.denominator, 'observed_balance_sum')
    assert.equal(deriveHolderConcentrationFromTransfers(LAUNCH, ASTEROID, SUPPLY_1B)!.denominator, 'total_supply')
  })

  it('dev-cluster overlay keeps the replay as diagnostic only: no holders, no top-N, no cluster supply', async () => {
    const overlay = await overlayFromLaunch(SUPPLY_1B)
    assert.deepEqual(overlay.holders, [])
    assert.equal(overlay.top1Pct, null)
    assert.equal(overlay.top10Pct, null)
    assert.equal(overlay.clusterSupplyPercent, null)
    assert.equal(overlay.creatorInTopHolders, null)
    assert.notEqual(overlay.holdersSource, 'transfer_derived')
    assert.equal(overlay.transferDerivedDiagnostic?.usedForPublicHolders, false)
    assert.equal(overlay.transferDerivedDiagnostic?.denominator, 'total_supply')
    assert.equal(overlay.audit.holderResolution.transferDerived?.window, 'earliest_token_transfers')
    assert.ok(overlay.audit.holderResolution.sourcesTried.includes('transfer_derived'))
  })

  it('never produces public Top1 = 61.82% through the route merge', async () => {
    const overlay = await overlayFromLaunch(null)
    const merged = mergeDevClusterOverlayHolders({
      holderRows: pctlessRows, holderDistribution: baseDist(pctlessRows, null), holderDistributionStatus: partialStatus,
      overlay, transferDerivedAvailable: overlay.transferDerivedDiagnostic != null,
    })
    assert.equal(merged.transferDerivedRejected, true)
    assert.equal(merged.holderDistribution.top1, null)
    assert.equal(merged.holderDistribution.top10, null)
    assert.deepEqual(merged.holderRows, pctlessRows)
    assert.ok(merged.holderRows.every((r) => r.percent !== 61.82))
    assert.equal(merged.holderDistributionStatus.reason, TRANSFER_DERIVED_NOT_CURRENT_REASON)
    assert.equal(merged.holderDistributionStatus.status, 'partial')
  })

  it('legacy/cached transfer_derived overlay rows are still rejected', () => {
    const d = deriveHolderConcentrationFromTransfers(LAUNCH, ASTEROID, null)!
    const merged = mergeDevClusterOverlayHolders({
      holderRows: [] as Row[], holderDistribution: baseDist([], null), holderDistributionStatus: partialStatus,
      overlay: { holders: d.rows, holdersSource: 'transfer_derived', top1Pct: d.top1Pct, top10Pct: d.top10Pct, top20Pct: d.top20Pct },
    })
    assert.deepEqual(merged.holderRows, [])
    assert.equal(merged.holderDistribution.top1, null)
    assert.deepEqual(merged.holderDistribution.topHolders, [])
  })

  it('cached transfer_derived holders are not reused by the overlay', async () => {
    const d = deriveHolderConcentrationFromTransfers(LAUNCH, ASTEROID, null)!
    const cached = { chainId: 1, tokenAddress: ASTEROID, result: { holders: d.rows, holdersSource: 'transfer_derived', linkedWallets: [], graphRan: false, originAddress: DEPLOYER } }
    const overlay = await resolveDevClusterDiagnosis({
      chainSlug: 'eth', chainId: 1, tokenAddress: ASTEROID,
      fetchImpl: async () => { throw new Error('network disabled in test') },
      cacheGet: async () => cached, cacheSet: async () => {},
      existing: { deployerAddress: DEPLOYER, deployerStatus: 'confirmed', holders: [], transfers: LAUNCH, linkedGraphStatus: 'ok', originDiscoveryAttempted: true },
    })
    assert.ok(overlay.holders.every((h) => h.percent !== 61.82))
    assert.equal(overlay.top1Pct, null)
    assert.equal(overlay.clusterSupplyPercent, null)
  })
})

describe('holder count semantics', () => {
  it('valid provider total survives while concentration becomes unavailable/partial', async () => {
    const count = resolveHolderCountSemantics({ providerTotal: 3545, normalizedRows: 2, resolverRows: 2 })
    assert.deepEqual(count, { holderCount: 3545, holderCountReason: 'holder_count_from_provider_total', holderCountExact: true, holderCountCapped: false })
    const overlay = await overlayFromLaunch(SUPPLY_1B)
    const merged = mergeDevClusterOverlayHolders({
      holderRows: pctlessRows, holderDistribution: baseDist(pctlessRows, count.holderCount), holderDistributionStatus: partialStatus,
      overlay, transferDerivedAvailable: true,
    })
    assert.equal(merged.holderDistribution.holderCount, 3545)
    assert.equal(merged.holderDistribution.top1, null)
    assert.equal(merged.holderDistributionStatus.status, 'partial')
  })

  it('fallback row length is never an exact holder count', () => {
    const rows10 = resolveHolderCountSemantics({ providerTotal: null, normalizedRows: 10, resolverRows: 10 })
    assert.equal(rows10.holderCount, null)
    assert.equal(rows10.holderCountExact, false)
    assert.equal(rows10.holderCountCapped, true)
    assert.equal(rows10.holderCountReason, 'holder_count_from_normalized_rows')
    const shown = formatHolderCountDisplay({ holderCount: rows10.holderCount, holderCountReason: rows10.holderCountReason, isCapped: rows10.holderCountCapped, holderRowsReturned: 10 })
    assert.equal(shown.display, '10+')
    assert.equal(shown.exact, false)
    assert.equal(resolveHolderCountSemantics({ providerTotal: 0, normalizedRows: 0, resolverRows: 0 }).holderCountReason, 'holder_count_unavailable_with_reason')
    assert.equal(resolveHolderCountSemantics({ providerTotal: 0, normalizedRows: 5, resolverRows: 5 }).holderCount, null)
  })

  it('rpc supply parsing for the diagnostic denominator', () => {
    assert.equal(rpcSupplyToDecimal('0x033b2e3c9fd0803ce8000000'), SUPPLY_1B)
    assert.equal(rpcSupplyToDecimal('0x'), null)
    assert.equal(rpcSupplyToDecimal('0x0'), null)
    assert.equal(rpcSupplyToDecimal(null), null)
  })
})

describe('valid current holder rows are unchanged', () => {
  const validRows = [
    { rank: 1, address: POOL, amount: '1', percent: 10.31 },
    { rank: 2, address: DEPLOYER, amount: '1', percent: 4.33 },
    ...Array.from({ length: 18 }, (_, i) => ({ rank: i + 3, address: `0x${(i + 1).toString(16).padStart(40, '0')}`, amount: '1', percent: 2 })),
  ]
  const validDist = { top1: 10.31, top10: 32.64, top20: 50.64, others: 49.36, holderCount: 3545, topHolders: validRows }
  const okStatus = { status: 'ok', reason: 'holder_percentages_verified', itemCount: 20, normalizedCount: 20, percentSource: 'provider' }
  const candidates = buildEvmCustodyCandidates({ chain: 'eth', tokenAddress: ASTEROID, pools: [{ address: POOL, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap_v2' }] })
  const stage = (rows: typeof validRows) => {
    const annotated = annotateLiquidityCustody({ chain: 'eth', holders: rows, candidates })
    return { custody: annotated.liquidityCustody, ordinary: computeOrdinaryConcentration({ holders: annotated.holders }) }
  }

  it('merge is identity with a transfer diagnostic present; Stage 1 and Stage 2 bit-identical', async () => {
    const before = stage(validRows)
    const overlay = await overlayFromLaunch(SUPPLY_1B, validRows.map((r) => ({ address: r.address, percent: r.percent })))
    const merged = mergeDevClusterOverlayHolders({ holderRows: validRows, holderDistribution: validDist, holderDistributionStatus: okStatus, overlay, transferDerivedAvailable: overlay.transferDerivedDiagnostic != null })
    assert.equal(merged.holderRows, validRows)
    assert.equal(merged.holderDistribution, validDist)
    assert.equal(merged.holderDistributionStatus, okStatus)
    assert.deepEqual(stage(merged.holderRows as typeof validRows), before)
    assert.equal(before.custody.custodyPercentOfSupply, 10.31)
  })

  it('valid rows with an existing-source overlay keep prior behavior (no diagnostic replay)', async () => {
    const overlay = await overlayFromLaunch(SUPPLY_1B, validRows.map((r) => ({ address: r.address, percent: r.percent })))
    assert.equal(overlay.transferDerivedDiagnostic, null)
    assert.equal(overlay.top1Pct, 10.31)
  })
})

describe('Dev Control / cluster supply cannot use launch rows', () => {
  it('cluster supply from pct-less current rows is null even though the launch replay has the deployer', async () => {
    const d = deriveHolderConcentrationFromTransfers(LAUNCH, ASTEROID, null)!
    // Pre-fix path: launch rows fed cluster supply.
    assert.ok((clusterSupplyFromHolders(d.rows, DEPLOYER, []) ?? 0) > 0)
    const overlay = await overlayFromLaunch(null)
    assert.equal(overlay.clusterSupplyPercent, null)
    assert.equal(overlay.audit.linkedWalletGraph.linkedWalletSupplyPct, null)
    const merged = mergeDevClusterOverlayHolders({ holderRows: pctlessRows, holderDistribution: baseDist(pctlessRows, null), holderDistributionStatus: partialStatus, overlay, transferDerivedAvailable: true })
    assert.equal(clusterSupplyFromHolders(merged.holderRows, DEPLOYER, []), null)
  })
})

describe('route wiring (static)', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/token/route.ts'), 'utf8')
  it('route uses the policy and no longer swaps in transfer-derived rows', () => {
    assert.ok(route.includes('mergeDevClusterOverlayHolders({'))
    assert.ok(route.includes('resolveHolderCountSemantics({'))
    assert.ok(route.includes('totalSupplyRaw: rpcSupplyToDecimal(rpcSupply)'))
    assert.ok(!route.includes('holder_percentages_derived_from_transfers'))
    assert.ok(!/normalizedTop\.length > 0 \? normalizedTop\.length/.test(route))
  })
})
