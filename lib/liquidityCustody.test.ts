/**
 * Stage-1 liquidity-custody annotator regressions.
 * Run: npx tsx --test lib/liquidityCustody.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  annotateLiquidityCustody,
  buildEvmCustodyCandidates,
  buildSolanaCustodyCandidates,
  verifiedVaultsFromSolanaClusterMap,
  ROBINHOOD_V4_POOL_MANAGER_ADDRESS,
} from './liquidityCustody'

const TOKEN = '0x1111111111111111111111111111111111111111'
const PAIR_V2 = '0x2222222222222222222222222222222222222222'
const POOL_V3 = '0x3333333333333333333333333333333333333333'
const SECONDARY_V2 = '0x4444444444444444444444444444444444444444'
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ROUTER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function holders(rows: Array<{ address: string; percent: number }>) {
  return rows.map((r, i) => ({ rank: i + 1, address: r.address, amount: '0', percent: r.percent }))
}

describe('EVM V2 pair custody', () => {
  it('classifies verified V2 pair contract as liquidity_custody and leaves wallets ordinary', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'base',
      tokenAddress: TOKEN,
      pools: [{ address: PAIR_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap_v2' }],
    })
    const raw = holders([
      { address: PAIR_V2, percent: 40 },
      { address: WALLET, percent: 5 },
    ])
    const top1Before = raw[0].percent
    const top10Before = raw.reduce((s, h) => s + h.percent, 0)
    const { holders: out, liquidityCustody } = annotateLiquidityCustody({
      chain: 'base',
      holders: raw,
      candidates,
    })
    assert.equal(out[0].classification?.kind, 'liquidity_custody')
    assert.equal(out[0].classification?.role, 'amm_pool_reserves')
    assert.equal(out[1].classification?.kind, 'ordinary')
    assert.equal(out[0].percent, top1Before, 'Top-1 percent must be unchanged')
    assert.equal(out.reduce((s, h) => s + (h.percent ?? 0), 0), top10Before, 'sum of percents must be unchanged')
    assert.equal(liquidityCustody.status, 'partial')
    assert.equal(liquidityCustody.custodyCoverageComplete, false)
    assert.equal(liquidityCustody.rows.length, 1)
    assert.equal(liquidityCustody.custodyPercentOfSupply, 40)
  })

  it('does not classify a pool_id (bytes32) style identity as a holder address', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'base',
      tokenAddress: TOKEN,
      pools: [{
        address: null,
        poolId: '0x' + 'ab'.repeat(32),
        poolAddressType: 'pool_id',
        poolType: 'concentrated',
        dexId: 'uniswap_v4',
      }],
    })
    assert.equal(candidates.filter((c) => c.role === 'amm_pool_reserves').length, 0)
  })
})

describe('EVM V3 pool custody', () => {
  it('classifies verified V3 pool contract as liquidity_custody', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'eth',
      tokenAddress: TOKEN,
      pools: [{ address: POOL_V3, poolAddressType: 'contract', poolType: 'v3', dexId: 'uniswap_v3' }],
    })
    const { holders: out } = annotateLiquidityCustody({
      chain: 'eth',
      holders: holders([{ address: POOL_V3, percent: 12 }, { address: WALLET, percent: 3 }]),
      candidates,
    })
    assert.equal(out[0].classification?.kind, 'liquidity_custody')
    assert.equal(out[0].classification?.role, 'amm_pool_reserves')
    assert.ok(out[0].classification?.evidence.some((e) => /v3/.test(e)))
  })
})

describe('Robinhood V4 shared PoolManager', () => {
  it('classifies PoolManager only when scanned token has a verified V4 pool', () => {
    const withV4 = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: TOKEN,
      pools: [{
        address: null,
        poolId: '0x' + 'cd'.repeat(32),
        poolAddressType: 'pool_id',
        poolType: 'concentrated',
        dexId: 'uniswap_v4',
        dexName: 'Uniswap V4',
      }],
    })
    assert.ok(withV4.some((c) => c.address === ROBINHOOD_V4_POOL_MANAGER_ADDRESS && c.role === 'v4_pool_manager'))

    const withoutV4 = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: TOKEN,
      pools: [{ address: PAIR_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap_v2' }],
    })
    assert.ok(!withoutV4.some((c) => c.address === ROBINHOOD_V4_POOL_MANAGER_ADDRESS))

    const { holders: out, liquidityCustody } = annotateLiquidityCustody({
      chain: 'robinhood',
      holders: holders([
        { address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS, percent: 55 },
        { address: WALLET, percent: 2 },
      ]),
      candidates: withV4,
    })
    assert.equal(out[0].classification?.kind, 'liquidity_custody')
    assert.equal(out[0].classification?.role, 'v4_pool_manager')
    assert.ok(out[0].classification?.evidence.some((e) => /shared_singleton_not_attributed/.test(e)))
    assert.equal(out[0].classification?.label, 'Protocol custody (V4 PoolManager)')
    // Does not claim LP ownership / lock
    assert.ok(!JSON.stringify(out[0].classification).toLowerCase().includes('lock'))
    assert.ok(!JSON.stringify(liquidityCustody).toLowerCase().includes('lp owner'))
  })

  it('does not add PoolManager on non-Robinhood chains even with V4 meta', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'base',
      tokenAddress: TOKEN,
      pools: [{
        address: null,
        poolId: '0x' + 'ef'.repeat(32),
        poolAddressType: 'pool_id',
        poolType: 'concentrated',
        dexId: 'uniswap_v4',
      }],
    })
    assert.ok(!candidates.some((c) => c.address === ROBINHOOD_V4_POOL_MANAGER_ADDRESS))
  })
})

describe('secondary pools + duplicate custody identity', () => {
  it('annotates secondary V2 pool and dedupes the same address across multiple pool refs', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'bnb',
      tokenAddress: TOKEN,
      pools: [
        { address: PAIR_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'pancakeswap_v2' },
        { address: SECONDARY_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'pancakeswap_v2' },
        // duplicate identity for primary — must not create two candidate rows
        { address: PAIR_V2, poolAddressType: 'contract', poolType: 'aerodrome', dexId: 'aerodrome' },
      ],
    })
    assert.equal(candidates.filter((c) => c.address === PAIR_V2).length, 1)
    assert.equal(candidates.length, 2)

    const { liquidityCustody } = annotateLiquidityCustody({
      chain: 'bnb',
      holders: holders([
        { address: PAIR_V2, percent: 30 },
        { address: PAIR_V2, percent: 30 }, // malformed duplicate holder rows — still one custody row
        { address: SECONDARY_V2, percent: 10 },
      ]),
      candidates,
    })
    assert.equal(liquidityCustody.rows.length, 2, 'same custody address counted once')
    assert.equal(liquidityCustody.custodyPercentOfSupply, 40)
  })
})

describe('no false ordinary / router / name-only inference', () => {
  it('does not classify routers or unrelated wallets; unknown stays ordinary not safe/risky', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'eth',
      tokenAddress: TOKEN,
      pools: [{ address: PAIR_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap_v2' }],
    })
    const { holders: out } = annotateLiquidityCustody({
      chain: 'eth',
      holders: holders([
        { address: ROUTER, percent: 1 },
        { address: WALLET, percent: 2 },
      ]),
      candidates,
    })
    assert.equal(out[0].classification?.kind, 'ordinary')
    assert.equal(out[1].classification?.kind, 'ordinary')
    assert.ok(!out.some((h) => /safe|risky/i.test(JSON.stringify(h.classification))))
  })
})


describe('evidence sufficiency — no contract/name-only false positives', () => {
  it('does not classify an address merely because it is a contract-shaped holder', () => {
    const randomContract = '0xcccccccccccccccccccccccccccccccccccccccc'
    const candidates = buildEvmCustodyCandidates({
      chain: 'base',
      tokenAddress: TOKEN,
      pools: [], // no verified pools
    })
    const { holders: out } = annotateLiquidityCustody({
      chain: 'base',
      holders: holders([{ address: randomContract, percent: 90 }]),
      candidates,
    })
    assert.equal(out[0].classification?.kind, 'ordinary')
  })

  it('does not classify from unknown poolType or missing poolAddressType even with an address', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'eth',
      tokenAddress: TOKEN,
      pools: [
        { address: PAIR_V2, poolAddressType: 'contract', poolType: 'unknown', dexId: 'uniswap' },
        { address: POOL_V3, poolType: 'v2', dexId: 'uniswap_v2' }, // missing poolAddressType
        { address: ROUTER, poolAddressType: 'unknown', poolType: 'v2', dexId: 'uniswap_v2' },
      ],
    })
    assert.equal(candidates.length, 0)
  })

  it('does not treat bare uniswap + pool_id as V4 (no PoolManager candidate)', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: TOKEN,
      pools: [{
        address: null,
        poolId: '0x' + 'aa'.repeat(32),
        poolAddressType: 'pool_id',
        poolType: 'unknown',
        dexId: 'uniswap',
        dexName: 'Uniswap',
      }],
    })
    assert.ok(!candidates.some((c) => c.role === 'v4_pool_manager'))
  })

  it('does not classify from name-only uniswap_v4 dex without a bytes32 poolId', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: TOKEN,
      pools: [{
        address: null,
        poolId: null,
        poolAddressType: 'pool_id',
        poolType: 'concentrated',
        dexId: 'uniswap_v4',
        dexName: 'Uniswap V4',
      }],
    })
    assert.ok(!candidates.some((c) => c.role === 'v4_pool_manager'))
  })

  it('PoolManager candidate keeps poolRef null even with multiple verified V4 poolIds', () => {
    const id1 = '0x' + '11'.repeat(32)
    const id2 = '0x' + '22'.repeat(32)
    const candidates = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: TOKEN,
      pools: [
        { address: null, poolId: id1, poolAddressType: 'pool_id', poolType: 'uniswap_v4', dexId: 'uniswap_v4' },
        { address: null, poolId: id2, poolAddressType: 'pool_id', poolType: 'concentrated', dexId: 'uniswap_v4' },
      ],
    })
    const pm = candidates.find((c) => c.role === 'v4_pool_manager')
    assert.ok(pm)
    assert.equal(pm!.poolRef, null)
    assert.ok(pm!.evidence.some((e) => e.includes(id1)))
    assert.ok(pm!.evidence.some((e) => e.includes(id2)))
    assert.ok(pm!.evidence.some((e) => /shared_singleton_not_attributed/.test(e)))
  })
})

describe('Solana verified vault vs unknown vault', () => {
  const MINT = 'So11111111111111111111111111111111111111112'
  const VAULT = 'Vault1111111111111111111111111111111111111'
  const ATA = 'Ata222222222222222222222222222222222222222'

  it('classifies only verified vault addresses; unknown ATA left ordinary/unclassified path is ordinary', () => {
    const candidates = buildSolanaCustodyCandidates({
      mintAddress: MINT,
      verifiedVaultAccounts: [{ address: VAULT, evidence: ['ata_owner_equals_verified_pool'] }],
    })
    const { holders: out, liquidityCustody } = annotateLiquidityCustody({
      chain: 'solana',
      holders: [
        { address: VAULT, percent: 22 },
        { address: ATA, percent: 8 },
      ],
      candidates,
    })
    assert.equal(out[0].classification?.kind, 'liquidity_custody')
    assert.equal(out[0].classification?.role, 'solana_amm_vault')
    assert.equal(out[1].classification?.kind, 'ordinary')
    assert.equal(liquidityCustody.status, 'partial')
  })

  it('with no verified vaults, leaves all unclassified as ordinary and status none — owner alone never invents custody', () => {
    const candidates = buildSolanaCustodyCandidates({ mintAddress: MINT, verifiedVaultAccounts: [] })
    const { holders: out, liquidityCustody } = annotateLiquidityCustody({
      chain: 'solana',
      holders: [{ address: ATA, percent: 50 }],
      candidates,
    })
    assert.equal(candidates.length, 0)
    assert.equal(out[0].classification?.kind, 'ordinary')
    assert.equal(liquidityCustody.status, 'none')
    assert.ok(liquidityCustody.evidenceGaps.some((g) => /owner field alone/i.test(g) || /No verified AMM vault/i.test(g)))
  })

  it('verifiedVaultsFromSolanaClusterMap only pulls lp_vault nodes', () => {
    const vaults = verifiedVaultsFromSolanaClusterMap({
      nodes: [
        { address: VAULT, role: 'lp_vault', evidence: ['owner_match'] },
        { address: ATA, role: 'wallet', evidence: [] },
        { address: 'Pool33333333333333333333333333333333333333', role: 'pool', evidence: [] },
      ],
    })
    assert.deepEqual(vaults.map((v) => v.address), [VAULT])
  })
})

describe('unchanged Top-N / count / Dev Control / risk contract', () => {
  it('annotation never mutates percent fields used for Top-N math', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'base',
      tokenAddress: TOKEN,
      pools: [{ address: PAIR_V2, poolAddressType: 'contract', poolType: 'v2', dexId: 'uniswap' }],
    })
    const raw = holders([
      { address: PAIR_V2, percent: 41.2 },
      { address: WALLET, percent: 7.5 },
      { address: '0xcccccccccccccccccccccccccccccccccccccccc', percent: 3.1 },
    ])
    const snapshot = raw.map((h) => ({ ...h }))
    const { holders: out, percentsUnchanged } = annotateLiquidityCustody({
      chain: 'base',
      holders: raw,
      candidates,
    })
    assert.equal(percentsUnchanged, true)
    assert.deepEqual(
      out.map((h) => ({ address: h.address.toLowerCase(), percent: h.percent, rank: h.rank })),
      snapshot.map((h) => ({ address: h.address.toLowerCase(), percent: h.percent, rank: h.rank })),
    )
  })
})

describe('no false LP ownership / lock claims in Stage-1 payload', () => {
  it('summary never claims lock, burn, or LP ownership', () => {
    const candidates = buildEvmCustodyCandidates({
      chain: 'robinhood',
      tokenAddress: TOKEN,
      pools: [{
        address: null,
        poolId: '0x' + '11'.repeat(32),
        poolAddressType: 'pool_id',
        poolType: 'uniswap_v4',
        dexId: 'uniswap_v4',
      }],
    })
    const { liquidityCustody } = annotateLiquidityCustody({
      chain: 'robinhood',
      holders: holders([{ address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS, percent: 60 }]),
      candidates,
    })
    const blob = JSON.stringify(liquidityCustody).toLowerCase()
    assert.ok(!blob.includes('locked'))
    assert.ok(!blob.includes('burned'))
    assert.ok(!blob.includes('lp owner'))
    assert.ok(!blob.includes('ownership'))
    assert.equal(liquidityCustody.custodyCoverageComplete, false)
  })
})

console.log('liquidityCustody.test.ts: assertions registered')
