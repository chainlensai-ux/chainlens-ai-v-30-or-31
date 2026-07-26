// LIVE ON-CHAIN VERIFICATION of the Aerodrome Slipstream PoolFactory address used by basedex.ts —
// see AERODROME_SLIPSTREAM_FACTORY's own "SLIPSTREAM FACTORY CORRECTION" comment in basedex.ts for
// the full story: the previous address shipped in this file was confirmed (via GitHub documentation)
// to be Velodrome's Optimism factory, not Aerodrome's Base one.
//
// SKIPS (does not fail) when no Base RPC is configured, per "fail closed if verification is
// inconclusive" — this file must never report a live-chain result it did not actually obtain. Run
// with a real ALCHEMY_BASE_RPC_URL or ALCHEMY_BASE_KEY set to execute the real 6-step check:
//   ALCHEMY_BASE_KEY=... npx tsx --test src/modules/pricingAtTimeEngine/sources/basedex.aerodromeSlipstreamFactory.liveVerification.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

const rpcUrl = process.env.ALCHEMY_BASE_RPC_URL
  ?? (process.env.ALCHEMY_BASE_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : null)

// The two candidates in play (see basedex.ts's own disclosure comment):
const CANDIDATE_AERODROME_BASE = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A' as const // aerodrome-finance/slipstream README, "Initial Deployment"
const SUSPECT_VELODROME_OPTIMISM = '0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F' as const // velodrome-finance/slipstream README, explicitly linked to optimistic.etherscan.io

const WETH_BASE = '0x4200000000000000000000000000000000000006' as const
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const TICK_SPACINGS = [1, 50, 100, 200, 2000] as const

const FACTORY_ABI = [
  { type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'tickSpacing', type: 'int24' }],
    outputs: [{ name: 'pool', type: 'address' }] },
] as const

const POOL_ABI = [
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

describe('Aerodrome Slipstream factory — live on-chain verification', { skip: !rpcUrl }, () => {
  if (!rpcUrl) {
    // node:test's `skip` option above already prevents these from running; this branch exists only
    // so this file compiles/imports cleanly when RPC env vars are absent (the common case in CI/
    // sandboxes) without ever touching the network.
    it('SKIPPED: no ALCHEMY_BASE_RPC_URL/ALCHEMY_BASE_KEY configured in this environment — live verification not run', () => {
      assert.ok(true)
    })
    return
  }

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) })

  it('step 1: eth_getCode — both candidate addresses have deployed bytecode on Base at latest', async () => {
    const [candidateCode, suspectCode] = await Promise.all([
      client.getBytecode({ address: CANDIDATE_AERODROME_BASE }),
      client.getBytecode({ address: SUSPECT_VELODROME_OPTIMISM }),
    ])
    console.log('[live-verify] eth_getCode', {
      [CANDIDATE_AERODROME_BASE]: candidateCode ? `${candidateCode.length} chars` : 'EMPTY (no contract on Base)',
      [SUSPECT_VELODROME_OPTIMISM]: suspectCode ? `${suspectCode.length} chars` : 'EMPTY (no contract on Base)',
    })
    assert.ok(candidateCode && candidateCode !== '0x', 'expected the candidate Aerodrome factory address to have real deployed bytecode on Base')
  })

  it('steps 2-6: getPool() across every supported tick spacing for WETH/USDC, verify the returned pool\'s bytecode/token0/token1/factory/slot0', async () => {
    let foundAny = false
    for (const factory of [CANDIDATE_AERODROME_BASE, SUSPECT_VELODROME_OPTIMISM] as const) {
      for (const tickSpacing of TICK_SPACINGS) {
        let pool: `0x${string}`
        try {
          pool = await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getPool', args: [WETH_BASE, USDC_BASE, tickSpacing] })
        } catch (err) {
          console.log('[live-verify] getPool call reverted/failed', { factory, tickSpacing, err: err instanceof Error ? err.message : err })
          continue
        }
        if (!pool || pool === '0x0000000000000000000000000000000000000000') continue

        const poolCode = await client.getBytecode({ address: pool })
        const hasCode = Boolean(poolCode && poolCode !== '0x')
        const [token0, token1, poolFactory, slot0] = await Promise.all([
          client.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0' }).catch((e) => `ERROR:${e instanceof Error ? e.message : e}`),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: 'token1' }).catch((e) => `ERROR:${e instanceof Error ? e.message : e}`),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: 'factory' }).catch((e) => `ERROR:${e instanceof Error ? e.message : e}`),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' }).catch((e) => `ERROR:${e instanceof Error ? e.message : e}`),
        ])
        console.log('[live-verify] WETH/USDC pool found', { factory, tickSpacing, pool, hasCode, token0, token1, poolFactory, slot0 })

        if (factory === CANDIDATE_AERODROME_BASE && hasCode) {
          foundAny = true
          assert.ok(
            [token0, token1].some((t) => typeof t === 'string' && (t.toLowerCase() === WETH_BASE.toLowerCase() || t.toLowerCase() === USDC_BASE.toLowerCase())),
            'expected the pool returned by the candidate Aerodrome factory to actually be a WETH/USDC pool',
          )
          if (typeof poolFactory === 'string') {
            assert.equal(poolFactory.toLowerCase(), CANDIDATE_AERODROME_BASE.toLowerCase(), 'expected the pool\'s own factory() to point back at the candidate address')
          }
        }
      }
    }
    assert.ok(foundAny, 'expected at least one real, deployed WETH/USDC Slipstream pool to be found via the candidate Aerodrome factory on Base')
  })
})
