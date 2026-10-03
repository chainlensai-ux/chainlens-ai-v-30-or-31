// lib/pricing/onchainPoolSource.ts — CURRENT on-chain pool discovery + state for the canonical resolver.
//
// No existing current-state reader exists (basedex.ts is block-pinned, Base-only, historical), so this is
// a small, bounded reader over the SAME RPC config (rpcDecimals.ts getRpcClientForChain). Two multicalls
// per token at most: (1) factory lookups against the requested counterparts, (2) pool state for the hits.
//
// IDENTITY IS READ, NEVER ASSUMED:
//   - V2 / V3: token0()/token1() are read from the returned pool and must equal {token, counterpart};
//     a zero address or any other pair is discarded, so even a wrong factory answer cannot price a token.
//   - V4: the poolId is keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)) — it commits to
//     both currencies; a non-zero slot0 proves the pool exists in the PoolManager. Only hookless pools with
//     the standard fee/tick-spacing pairs are discovered (a hooked pool's price can be hook-distorted).
// Factory / PoolManager addresses: V3 Base factory and both V4 PoolManagers are the ones already used in
// this repo (basedex.ts / uniswapV3PoolValidator.ts, v4SwapCandlesRpc.ts, uniswapV4BaseRpc.ts); the
// Uniswap V2 factories and the Ethereum V3 factory are Uniswap's canonical deployments. Chains: Ethereum and
// Base (the Wallet Scanner's default holdings chains). Never throws — any failure is an empty list.

import { encodeAbiParameters, keccak256, type PublicClient } from 'viem'
import type { OnchainPoolLookup, OnchainPoolState } from './currentPriceResolver'
import { V4_NATIVE_CURRENCY } from './currentPriceResolver'

type ChainPools = { v2Factory: `0x${string}`; v3Factory: `0x${string}`; v4PoolManager: `0x${string}` }

export const ONCHAIN_POOL_CHAINS: Record<number, ChainPools> = {
  1: {
    v2Factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  },
  8453: {
    v2Factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    v3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  },
}

const V3_FEES = [100, 500, 3000, 10000] as const
const V4_FEE_TICK_SPACINGS: ReadonlyArray<readonly [number, number]> = [[100, 1], [500, 10], [3000, 60], [10000, 200]]
const V4_POOLS_SLOT = BigInt(6)
const V4_LIQUIDITY_OFFSET = BigInt(3)
const ZERO = '0x0000000000000000000000000000000000000000'

const V2_FACTORY_ABI = [{ type: 'function', name: 'getPair', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'address' }] }] as const
const V3_FACTORY_ABI = [{ type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] }] as const
const PAIR_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] },
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }] },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
] as const
const ERC20_BALANCE_ABI = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const
const EXTSLOAD_ABI = [{ type: 'function', name: 'extsload', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }] }] as const

const lc = (a: string) => a.toLowerCase()

/** V4 poolId for a hookless pool (currencies sorted ascending, as the PoolManager requires). */
export function v4PoolId(a: string, b: string, fee: number, tickSpacing: number): `0x${string}` {
  const [c0, c1] = lc(a) < lc(b) ? [a, b] : [b, a]
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [c0 as `0x${string}`, c1 as `0x${string}`, fee, tickSpacing, ZERO],
  ))
}

function v4StateSlot(poolId: `0x${string}`): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, V4_POOLS_SLOT])))
}

const toSlot = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`
const MASK160 = (BigInt(1) << BigInt(160)) - BigInt(1)
const MASK128 = (BigInt(1) << BigInt(128)) - BigInt(1)

type Discovery = { kind: 'v2' | 'v3' | 'v4'; pool: string; counterpart: string }

export function createOnchainPoolSource(
  getClient: (chainId: number) => PublicClient | null,
  decimals: (chainId: number, token: string) => Promise<number | null>,
): OnchainPoolLookup {
  async function listPools(chainId: number, token: string, counterparts: string[]): Promise<OnchainPoolState[]> {
    const cfg = ONCHAIN_POOL_CHAINS[chainId]
    const client = getClient(chainId)
    if (!cfg || !client) return []
    const t = lc(token) as `0x${string}`
    try {
      // (1) discovery
      const discoveries: Discovery[] = []
      const calls: Array<{ address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }> = []
      const meta: Array<Discovery & { v4Slot?: bigint }> = []
      for (const cRaw of counterparts) {
        const c = lc(cRaw) as `0x${string}`
        if (c === t) continue
        if (c !== V4_NATIVE_CURRENCY) {
          calls.push({ address: cfg.v2Factory, abi: V2_FACTORY_ABI, functionName: 'getPair', args: [t, c] })
          meta.push({ kind: 'v2', pool: '', counterpart: c })
          for (const fee of V3_FEES) {
            calls.push({ address: cfg.v3Factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [t, c, fee] })
            meta.push({ kind: 'v3', pool: '', counterpart: c })
          }
        }
        for (const [fee, ts] of V4_FEE_TICK_SPACINGS) {
          const id = v4PoolId(t, c, fee, ts)
          const slot = v4StateSlot(id)
          calls.push({ address: cfg.v4PoolManager, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [toSlot(slot)] })
          meta.push({ kind: 'v4', pool: id, counterpart: c, v4Slot: slot })
        }
      }
      if (calls.length === 0) return []
      const found = (await client.multicall({ contracts: calls as never, allowFailure: true })) as Array<{ status: 'success' | 'failure'; result?: unknown }>
      const v4Slot0 = new Map<string, bigint>()
      found.forEach((r, i) => {
        const m = meta[i]
        if (r.status !== 'success') return
        if (m.kind === 'v4') {
          const word = BigInt(r.result as string)
          const sqrt = word & MASK160
          if (sqrt > BigInt(0)) { discoveries.push({ ...m }); v4Slot0.set(m.pool, sqrt) }
        } else {
          const addr = lc(String(r.result))
          if (addr !== ZERO && addr.startsWith('0x')) discoveries.push({ kind: m.kind, pool: addr, counterpart: m.counterpart })
        }
      })
      if (discoveries.length === 0) return []

      // (2) state
      const stateCalls: typeof calls = []
      const stateMeta: Array<{ d: Discovery; field: string }> = []
      for (const d of discoveries) {
        const pool = d.pool as `0x${string}`
        if (d.kind === 'v2') {
          for (const fn of ['token0', 'token1', 'getReserves'] as const) { stateCalls.push({ address: pool, abi: PAIR_ABI, functionName: fn, args: [] }); stateMeta.push({ d, field: fn }) }
        } else if (d.kind === 'v3') {
          for (const fn of ['token0', 'token1', 'slot0', 'liquidity'] as const) { stateCalls.push({ address: pool, abi: PAIR_ABI, functionName: fn, args: [] }); stateMeta.push({ d, field: fn }) }
          stateCalls.push({ address: d.counterpart as `0x${string}`, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [pool] }); stateMeta.push({ d, field: 'quoteBalance' })
        } else {
          const slot = v4StateSlot(d.pool as `0x${string}`) + V4_LIQUIDITY_OFFSET
          stateCalls.push({ address: cfg.v4PoolManager, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [toSlot(slot)] }); stateMeta.push({ d, field: 'v4liquidity' })
        }
      }
      const states = (await client.multicall({ contracts: stateCalls as never, allowFailure: true })) as Array<{ status: 'success' | 'failure'; result?: unknown }>
      const byPool = new Map<string, Record<string, unknown>>()
      states.forEach((r, i) => {
        const { d, field } = stateMeta[i]
        const rec = byPool.get(d.pool) ?? {}
        rec[field] = r.status === 'success' ? r.result : undefined
        byPool.set(d.pool, rec)
      })
      const out: OnchainPoolState[] = []
      for (const d of discoveries) {
        const rec = byPool.get(d.pool) ?? {}
        if (d.kind === 'v4') {
          const [c0, c1] = t < d.counterpart ? [t, d.counterpart] : [d.counterpart, t]
          const liq = rec.v4liquidity != null ? BigInt(rec.v4liquidity as string) & MASK128 : null
          out.push({ kind: 'v4', poolAddress: d.pool, token0: c0, token1: c1, sqrtPriceX96: v4Slot0.get(d.pool) ?? null, liquidity: liq })
          continue
        }
        const t0 = rec.token0 ? lc(String(rec.token0)) : null
        const t1 = rec.token1 ? lc(String(rec.token1)) : null
        // Identity check: the pool must be exactly {token, counterpart}.
        const pair = new Set([t0, t1])
        if (!t0 || !t1 || !pair.has(t) || !pair.has(d.counterpart)) continue
        if (d.kind === 'v2') {
          const reserves = rec.getReserves as readonly [bigint, bigint, number] | undefined
          out.push({ kind: 'v2', poolAddress: d.pool, token0: t0, token1: t1, reserve0: reserves?.[0] ?? null, reserve1: reserves?.[1] ?? null })
        } else {
          const slot0 = rec.slot0 as readonly [bigint, ...unknown[]] | undefined
          out.push({ kind: 'v3', poolAddress: d.pool, token0: t0, token1: t1, sqrtPriceX96: slot0?.[0] ?? null, liquidity: (rec.liquidity as bigint | undefined) ?? null, quoteBalanceRaw: (rec.quoteBalance as bigint | undefined) ?? null })
        }
      }
      // Deterministic order.
      return out.sort((a, b) => a.kind.localeCompare(b.kind) || lc(a.poolAddress).localeCompare(lc(b.poolAddress)))
    } catch {
      return []
    }
  }
  return { listPools, decimals }
}
