/**
 * Stage-2 ordinary concentration regressions.
 * Run: npx tsx --test lib/liquidityCustody.ordinary.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  annotateLiquidityCustody,
  buildEvmCustodyCandidates,
  buildSolanaCustodyCandidates,
  computeOrdinaryConcentration,
  ROBINHOOD_V4_POOL_MANAGER_ADDRESS,
} from './liquidityCustody'

const TOKEN = '0x1111111111111111111111111111111111111111'
const PAIR_V2 = '0x2222222222222222222222222222222222222222'
const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function makeHolders(n: number, custodyAt?: { index: number; address: string; percent: number }) {
  const rows: Array<{ rank: number; address: string; amount: string; percent: number }> = []
  for (let i = 0; i < n; i++) {
    if (custodyAt && i === custodyAt.index) {
      rows.push({ rank: i + 1, address: custodyAt.address, amount: '0', percent: custodyAt.percent })
    } else {
      rows.push({
        rank: i + 1,
        address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        amount: '0',
        percent: 1 + (i % 3) * 0.5,
      })
    }
  }
  return rows
}

describe('Stage-2 ordinary concentration — ETH/Base V2 pool', () => {
  it('excludes verified V2 pool reserve from ordinary ranking; total Top-N bit-identical', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'base',
      tokenAddress: TOKEN,
      pools: [{ address: PAIR_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap_v2' }],
    })
    const raw = makeHolders(12, { index: 0, address: PAIR_V2, percent: 40 })
    // Force remaining percents known
    raw[1].percent = 8
    raw[2].percent = 7
    for (let i = 3; i < 12; i++) raw[i].percent = 2

    const { holders: annotated } = annotateLiquidityCustody({ chain: 'base', holders: raw, candidates })
    const totalBefore = {
      top1: annotated[0].percent,
      top10: annotated.slice(0, 10).reduce((s, h) => s + (h.percent ?? 0), 0),
    }
    const series = computeOrdinaryConcentration({ holders: annotated, requestedDepth: 10 })

    assert.equal(series.totalTop1, totalBefore.top1)
    assert.equal(series.totalTop10, totalBefore.top10)
    assert.equal(annotated[0].classification?.kind, 'liquidity_custody')
    assert.equal(series.ordinaryCoverage.excludedCustodyCount, 1)
    assert.equal(series.ordinaryCoverage.excludedCustodyPercent, 40)
    // Ordinary top1 is first wallet after pool
    assert.equal(series.ordinaryTop1, 8)
    // Ordinary top10 = sum of 10 ordinary rows (indexes 1..10 in original = 8+7+2*8 = 31)
    assert.equal(series.ordinaryTop10, 8 + 7 + 2 * 8)
    assert.equal(series.ordinaryCoverage.status, 'verified')
    // Denominator unchanged: ordinary percents still % of total supply (not renormalized to 60%)
    assert.ok((series.ordinaryTop10 ?? 0) < (series.totalTop10 ?? 0))
  })
})

describe('Stage-2 ordinary concentration — Robinhood V4 PoolManager', () => {
  it('excludes PoolManager from ordinary only when verified with V4 poolId evidence', () => {
    const pm = ROBINHOOD_V4_POOL_MANAGER_ADDRESS
    const withV4 = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: TOKEN,
      pools: [{
        address: null,
        poolId: '0x' + 'ab'.repeat(32),
        poolAddressType: 'pool_id',
        poolType: 'concentrated',
        dexId: 'uniswap_v4',
      }],
    })
    const raw = makeHolders(11, { index: 0, address: pm, percent: 25 })
    for (let i = 1; i < 11; i++) raw[i].percent = 3
    const { holders: annotated } = annotateLiquidityCustody({
      chain: 'robinhood',
      holders: raw,
      candidates: withV4,
    })
    assert.equal(annotated[0].classification?.kind, 'liquidity_custody')
    const series = computeOrdinaryConcentration({ holders: annotated, requestedDepth: 10 })
    assert.equal(series.ordinaryCoverage.excludedCustodyCount, 1)
    assert.equal(series.ordinaryTop1, 3)
    assert.equal(series.ordinaryCoverage.status, 'verified')

    // Without V4 evidence — PoolManager not classified as custody → remains in ordinary
    const withoutV4 = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: TOKEN,
      pools: [{ address: PAIR_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap_v2' }],
    })
    const raw2 = makeHolders(11, { index: 0, address: pm, percent: 25 })
    for (let i = 1; i < 11; i++) raw2[i].percent = 3
    const { holders: annotated2 } = annotateLiquidityCustody({
      chain: 'robinhood',
      holders: raw2,
      candidates: withoutV4,
    })
    assert.notEqual(annotated2[0].classification?.kind, 'liquidity_custody')
    const series2 = computeOrdinaryConcentration({ holders: annotated2, requestedDepth: 10 })
    assert.equal(series2.ordinaryCoverage.excludedCustodyCount, 0)
    assert.equal(series2.ordinaryTop1, 25)
  })
})

describe('Stage-2 ordinary concentration — unclassified stays included', () => {
  it('keeps unknown/unclassified rows in ordinary series and blocks verified status', () => {
    const holders = [
      { address: WALLET_A, percent: 10, classification: { kind: 'ordinary' as const, evidence: [] } },
      { address: WALLET_B, percent: 9, classification: { kind: 'unclassified' as const, evidence: ['no_match'] } },
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `0x${(i + 3).toString(16).padStart(40, '0')}`,
        percent: 2,
        classification: { kind: 'ordinary' as const, evidence: [] },
      })),
    ]
    const series = computeOrdinaryConcentration({ holders, requestedDepth: 10 })
    assert.equal(series.ordinaryCoverage.excludedCustodyCount, 0)
    assert.equal(series.ordinaryTop1, 10)
    assert.ok(series.ordinaryTop10 != null)
    assert.equal(series.ordinaryCoverage.status, 'partial')
    assert.match(series.ordinaryCoverage.reason, /unclassified/)
  })
})

describe('Stage-2 ordinary concentration — denominator + monotonicity + duplicates', () => {
  it('denominator remains total supply; ordinary Top-N is monotonic; duplicate custody address excluded once', () => {
    const custody = {
      kind: 'liquidity_custody' as const,
      role: 'amm_pool_reserves' as const,
      evidence: ['verified_v2_pair'],
      label: 'V2',
    }
    const holders = [
      { address: PAIR_V2, percent: 30, classification: custody },
      { address: PAIR_V2.toLowerCase(), percent: 5, classification: custody }, // duplicate address row
      { address: WALLET_A, percent: 8, classification: { kind: 'ordinary' as const, evidence: [] } },
      ...Array.from({ length: 12 }, (_, i) => ({
        address: `0x${(i + 10).toString(16).padStart(40, '0')}`,
        percent: 1,
        classification: { kind: 'ordinary' as const, evidence: [] },
      })),
    ]
    const series = computeOrdinaryConcentration({ holders, requestedDepth: 10 })
    assert.equal(series.ordinaryCoverage.excludedCustodyCount, 1)
    assert.equal(series.ordinaryCoverage.excludedCustodyPercent, 30)
    assert.ok(series.ordinaryCoverage.evidence.includes('duplicate_custody_address_rows_excluded_once=1'))
    assert.equal(series.totalTop1, 30)
    assert.equal(series.ordinaryTop1, 8)
    assert.ok(series.ordinaryTop1 != null && series.ordinaryTop5 != null && series.ordinaryTop10 != null)
    assert.ok(series.ordinaryTop1 <= series.ordinaryTop5!)
    assert.ok(series.ordinaryTop5! <= series.ordinaryTop10!)
    // Not renormalized: ordinary top10 is sum of percents of supply; duplicate row stays out of ranking
    assert.equal(series.ordinaryTop10, 8 + 1 * 9)
  })
})

describe('Stage-2 ordinary concentration — insufficient depth', () => {
  it('returns partial/not_computed when holder depth cannot construct Top-N', () => {
    const custody = {
      kind: 'liquidity_custody' as const,
      evidence: ['verified_v2_pair'],
    }
    const short = [
      { address: PAIR_V2, percent: 40, classification: custody },
      { address: WALLET_A, percent: 10, classification: { kind: 'ordinary' as const, evidence: [] } },
      { address: WALLET_B, percent: 5, classification: { kind: 'ordinary' as const, evidence: [] } },
    ]
    const series = computeOrdinaryConcentration({ holders: short, requestedDepth: 10 })
    assert.equal(series.ordinaryCoverage.status, 'partial')
    assert.match(series.ordinaryCoverage.reason, /insufficient_ordinary_holder_depth/)
    assert.equal(series.ordinaryTop10, null)
    assert.equal(series.ordinaryTop1, 10)

    const empty = computeOrdinaryConcentration({ holders: [], requestedDepth: 10 })
    assert.equal(empty.ordinaryCoverage.status, 'not_computed')
    assert.equal(empty.ordinaryTop1, null)
  })
})

describe('Stage-2 ordinary concentration — replacement rows after custody removal', () => {
  it('promotes lower-ranked ordinary rows into Top-N after verified custody removal', () => {
    const custody = { kind: 'liquidity_custody' as const, evidence: ['v2'] }
    const holders = [
      { address: PAIR_V2, percent: 50, classification: custody },
      ...Array.from({ length: 12 }, (_, i) => ({
        address: `0x${(i + 2).toString(16).padStart(40, '0')}`,
        percent: 2,
        classification: { kind: 'ordinary' as const, evidence: [] },
      })),
    ]
    const series = computeOrdinaryConcentration({ holders, requestedDepth: 10 })
    assert.equal(series.totalTop10, 50 + 2 * 9)
    assert.equal(series.ordinaryTop10, 2 * 10)
    assert.equal(series.ordinaryCoverage.status, 'verified')
  })
})

describe('Stage-2 ordinary concentration — Solana vault gate', () => {
  it('does not compute ordinary series without verified vault evidence', () => {
    const holders = Array.from({ length: 12 }, (_, i) => ({
      address: `So${i.toString().padStart(42, '1')}`,
      percent: 3,
      classification: { kind: 'ordinary' as const, evidence: [] },
    }))
    const gated = computeOrdinaryConcentration({
      holders,
      requestedDepth: 10,
      custodyEvidenceAvailable: false,
    })
    assert.equal(gated.ordinaryCoverage.status, 'not_computed')
    assert.equal(gated.ordinaryTop10, null)
    assert.equal(gated.totalTop10, 30)

    const vault = 'Vault1111111111111111111111111111111111111'
    const candidates = buildSolanaCustodyCandidates({
      mintAddress: 'Mint1111111111111111111111111111111111111',
      verifiedVaultAccounts: [{ address: vault, evidence: ['cluster_map_lp_vault_node'] }],
    })
    const raw = [
      { rank: 1, address: vault, amountRaw: '1', percent: 40 },
      ...Array.from({ length: 11 }, (_, i) => ({
        rank: i + 2,
        address: `So${(i + 2).toString().padStart(42, '2')}`,
        amountRaw: '1',
        percent: 2,
      })),
    ]
    const { holders: annotated } = annotateLiquidityCustody({
      chain: 'solana',
      holders: raw,
      candidates,
    })
    assert.equal(annotated[0].classification?.kind, 'liquidity_custody')
    const series = computeOrdinaryConcentration({
      holders: annotated,
      requestedDepth: 10,
      custodyEvidenceAvailable: true,
    })
    assert.equal(series.ordinaryCoverage.excludedCustodyCount, 1)
    assert.equal(series.ordinaryTop10, 20)
    assert.equal(series.ordinaryCoverage.status, 'verified')
  })
})

describe('Stage-2 ordinary concentration — risk/Dev Control untouched by policy', () => {
  it('legacy total Top-N equals input sum and is independent of ordinary series', () => {
    const holders = makeHolders(15, { index: 2, address: PAIR_V2, percent: 22 })
    const candidates = buildEvmCustodyCandidates({
      chain: 'eth',
      tokenAddress: TOKEN,
      pools: [{ address: PAIR_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap_v2' }],
    })
    const { holders: annotated } = annotateLiquidityCustody({ chain: 'eth', holders, candidates })
    const legacyTop10 = annotated.slice(0, 10).reduce((s, h) => s + (h.percent ?? 0), 0)
    const series = computeOrdinaryConcentration({ holders: annotated, requestedDepth: 10 })
    assert.equal(series.totalTop10, legacyTop10)
    assert.notEqual(series.ordinaryTop10, series.totalTop10)
    // Policy reminder: callers must keep risk on totalTop*; this module never returns a risk score.
    assert.equal('riskScore' in series, false)
  })
})

console.log('liquidityCustody.ordinary.test.ts: registered')

describe('Stage-2 ordinary concentration — verified scope semantics', () => {
  it('verified is scoped to the requested Top-N window and never implies complete custody coverage', () => {
    const holders = Array.from({ length: 12 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      percent: 1,
      classification: { kind: 'ordinary' as const, evidence: [] },
    }))
    const series = computeOrdinaryConcentration({ holders, requestedDepth: 10 })
    assert.equal(series.ordinaryCoverage.status, 'verified')
    assert.equal(series.ordinaryCoverage.verifiedScope, 'requested_ordinary_top_n_window')
    assert.equal(series.ordinaryCoverage.impliesCompleteCustodyCoverage, false)
    assert.ok(series.ordinaryCoverage.evidence.includes('does_not_imply_custody_coverage_complete'))
    assert.match(series.ordinaryCoverage.reason, /not_full_custody_census/)
    const empty = computeOrdinaryConcentration({ holders: [] })
    assert.equal(empty.ordinaryCoverage.impliesCompleteCustodyCoverage, false)
  })
})
