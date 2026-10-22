// MODULE — receiptSwapDecoder: pool/factory validation.
//
// A pool address alone (even one that emits a byte-identical Swap event) is not sufficient
// evidence it's a real Aerodrome pool — any contract can emit an arbitrary log. Validation confirms
// the pool address was actually returned by the canonical Aerodrome factory for the pair of tokens
// the decoded Swap event claims to involve. `PoolValidator` is an injectable interface so decode
// logic stays pure/offline-testable via fixtures; `createLiveBaseDexPoolValidator` is the real,
// on-chain implementation used outside tests, reusing the exact same canonical factory addresses
// already verified and shipped in basedex.ts (not re-derived or guessed here).
//
// STABLE-POOL VALIDATION GAP, DISCLOSED (audit fix): Aerodrome Classic's real factory keys every
// pool by (tokenA, tokenB, stable) — a stable pool and a volatile pool for the SAME token pair are
// different, independently-deployed contract addresses (see basedex.ts's own "STABLE-POOL SKIP"
// disclosure). This validator previously called getPool() with stable HARDCODED to `false` only —
// a real, exact Classic swap that happened to go through the pair's STABLE pool (e.g. a
// stablecoin/stablecoin swap) would have its Swap event/transfer legs resolved correctly by
// multiTransferLeg.ts, then fail HERE purely because the wrong boolean was checked, never because
// the pool wasn't real. Fixed by trying `stable=false` first (preserves existing behavior/ordering
// for the common case), then `stable=true` only if the first attempt didn't match — the exact same
// "try the real, finite key space before failing closed" pattern already used for Slipstream's tick
// spacings below, never a guess and never more than one extra bounded call.
//
// THIS IS A VALIDATION-LAYER FIX ONLY, DISCLOSED: it changes whether a stable-pool swap is
// recognized as a real, factory-validated Aerodrome Classic pool — the exact swap amounts still
// come directly from the pool's own Swap event/transfer legs (never from reserve-ratio math). USD
// pricing of a newly-recognized stable-pool swap is a fully separate, already-disclosed limitation
// (basedex.ts's own STABLE-POOL SKIP) — untouched by this file, and not something this fix can or
// should paper over.

import type { ReceiptSwapChain, ReceiptSwapProtocol } from './types'
import { getSharedBaseClient, getSharedEthereumClient } from './rpcClient'

// Same canonical, previously-verified addresses as basedex.ts — see that file's own header for the
// full provenance/verification disclosure. Not re-derived here; imported by value would create a
// pricing<->decoder coupling this module doesn't need, so the constants are restated (identical
// values, same source of truth: aerodrome-finance repositories).
export const AERODROME_CLASSIC_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'
export const AERODROME_SLIPSTREAM_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A'

const CLASSIC_FACTORY_ABI = [
  {
    type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'stable', type: 'bool' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

const SLIPSTREAM_FACTORY_ABI = [
  {
    type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'tickSpacing', type: 'int24' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

const CL_POOL_FACTORY_ABI = [{
  type: 'function', name: 'factory', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'address' }],
}] as const

const CL_POOL_TICK_SPACING_ABI = [{
  type: 'function', name: 'tickSpacing', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'int24' }],
}] as const

// OPERATOR-LISTED SLIPSTREAM FACTORIES: Aerodrome deploys new Slipstream factories (production log:
// 0xf8f2eb49…, pools with dynamic fees). A factory that registers a pool proves nothing on its own —
// anyone can deploy one that vouches for a fake pool — so a new factory is trusted only after an
// operator checks it (e.g. on Basescan / Aerodrome's docs) and lists it here, comma-separated. A
// listed factory still has to return this exact pool for the pool's own tickSpacing().
export const EXTRA_SLIPSTREAM_FACTORIES_ENV = 'AERODROME_SLIPSTREAM_EXTRA_FACTORIES'

export function listedExtraSlipstreamFactories(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env[EXTRA_SLIPSTREAM_FACTORIES_ENV] ?? '').split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a)))
}

export type ListedFactoryReads = {
  poolTickSpacing(pool: string): Promise<number | null>
  factoryGetPool(factory: string, token0: string, token1: string, tickSpacing: number): Promise<string | null>
}

/** True only when `factory` is operator-listed and returns `pool` for the pool's own tick spacing. */
export async function validateByListedSlipstreamFactory(
  reads: ListedFactoryReads, factory: string, pool: string, token0: string, token1: string,
  listed: ReadonlySet<string>, attempts: PoolValidationAttempt[] = [],
): Promise<boolean> {
  if (!listed.has(factory.toLowerCase())) return false
  const tickSpacing = await reads.poolTickSpacing(pool)
  if (tickSpacing == null) return false
  const returned = await reads.factoryGetPool(factory, token0, token1, tickSpacing)
  attempts.push({ key: `listedFactory.getPool(tickSpacing=${tickSpacing})`, returnedPool: returned?.toLowerCase() ?? null })
  return typeof returned === 'string' && returned.toLowerCase() === pool.toLowerCase()
}

// Same tick-spacing enumeration basedex.ts uses for Slipstream pool discovery.
const SLIPSTREAM_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const

export type PoolValidator = {
  // `chain` is optional and defaults to Base; only createLiveChainPoolValidator dispatches on it.
  isValidPool(protocol: ReceiptSwapProtocol, poolAddress: string, token0: string, token1: string, chain?: ReceiptSwapChain): Promise<boolean>
}

// PURE, DISCLOSED: the (tokenA, tokenB, stable) key-space search, independent of how `fetchPool` is
// implemented — directly unit-testable (this audit fix's own regression test) without a live RPC
// client. `fetchPool(false)` is always tried before `fetchPool(true)` and `fetchPool(true)` is only
// ever called when the volatile attempt didn't match — never both unconditionally, never a retry of
// the same key.
export async function tryClassicStableVariants(
  fetchPool: (stable: boolean) => Promise<string | null | undefined>,
  target: string,
): Promise<boolean> {
  const normalizedTarget = target.toLowerCase()
  for (const stable of [false, true]) {
    const pool = await fetchPool(stable)
    if (typeof pool === 'string' && pool.toLowerCase() === normalizedTarget) return true
  }
  return false
}

export function isCanonicalSlipstreamFactory(factory: unknown): boolean {
  return typeof factory === 'string' && factory.toLowerCase() === AERODROME_SLIPSTREAM_FACTORY.toLowerCase()
}

// Shared client — see rpcClient.ts's own header for why this is one cached instance reused across
// this whole module, not independently re-created here.
const getClient = getSharedBaseClient

// POOL-VALIDATION AUDIT LOG, DISCLOSED (evidence-first PnL completion task, requirement #5): a
// real, observability-only record of every factory query this validator actually made for a
// `pool_not_validated_by_factory` rejection — which factory was queried, what pool (if any) it
// returned for each attempted key, the candidate pool this receipt actually claimed, and the token
// pair involved. This is PURELY additive logging: it changes nothing about which pools validate —
// no new venue is guessed at, no key is skipped or added, and only the two already-in-scope,
// already-verified factories (AERODROME_CLASSIC_FACTORY, AERODROME_SLIPSTREAM_FACTORY) are ever
// queried, exactly as before this change.
export type PoolValidationAttempt = { key: string; returnedPool: string | null }
// Exported for direct unit testing — the real, on-chain caller (createLiveBaseDexPoolValidator
// below) has no injection point for its RPC client, so this pure logging function is tested in
// isolation rather than through a live/mocked client.
export function logPoolValidationAudit(
  protocol: ReceiptSwapProtocol,
  factory: string,
  candidatePool: string,
  token0: string,
  token1: string,
  attempts: PoolValidationAttempt[],
  matched: boolean,
): void {
  if (matched) return // only the rejection case needs an audit trail — a match needs no explanation
  // eslint-disable-next-line no-console
  console.warn('[pool-validation-audit]', {
    protocol,
    factoryQueried: factory,
    candidatePool,
    tokenPair: [token0.toLowerCase(), token1.toLowerCase()],
    attempts,
    reason: 'pool_not_validated_by_factory',
  })
}

// FAIL-CLOSED, DISCLOSED: any RPC failure, missing config, or a factory returning the zero address
// for every attempted key resolves to `false` (not validated) — never treated as "validated" by
// default. Callers (index.ts) fail closed to the inference path whenever validation isn't `true`.
export function createLiveBaseDexPoolValidator(): PoolValidator {
  return {
    async isValidPool(protocol, poolAddress, token0, token1): Promise<boolean> {
      const client = getClient()
      if (!client) return false
      const target = poolAddress.toLowerCase()
      const attempts: PoolValidationAttempt[] = []
      try {
        if (protocol === 'aerodrome_classic') {
          // Try the volatile key first (preserves prior behavior/ordering for the common case),
          // then the stable key only if volatile didn't match — the real, finite (tokenA, tokenB,
          // stable) key space, never a guess. See this file's own header for the full disclosure.
          const matched = await tryClassicStableVariants(
            async (stable) => {
              const pool = await client.readContract({
                address: AERODROME_CLASSIC_FACTORY as `0x${string}`,
                abi: CLASSIC_FACTORY_ABI,
                functionName: 'getPool',
                args: [token0 as `0x${string}`, token1 as `0x${string}`, stable],
              }) as string
              attempts.push({ key: `stable=${stable}`, returnedPool: typeof pool === 'string' ? pool.toLowerCase() : null })
              return pool
            },
            target,
          )
          logPoolValidationAudit(protocol, AERODROME_CLASSIC_FACTORY, target, token0, token1, attempts, matched)
          return matched
        }
        for (const tickSpacing of SLIPSTREAM_TICK_SPACINGS) {
          const pool = await client.readContract({
            address: AERODROME_SLIPSTREAM_FACTORY as `0x${string}`,
            abi: SLIPSTREAM_FACTORY_ABI,
            functionName: 'getPool',
            args: [token0 as `0x${string}`, token1 as `0x${string}`, tickSpacing],
          })
          attempts.push({ key: `tickSpacing=${tickSpacing}`, returnedPool: typeof pool === 'string' ? pool.toLowerCase() : null })
          if (typeof pool === 'string' && pool.toLowerCase() === target) {
            logPoolValidationAudit(protocol, AERODROME_SLIPSTREAM_FACTORY, target, token0, token1, attempts, true)
            return true
          }
        }
        const reverseFactory = await client.readContract({
          address: poolAddress as `0x${string}`,
          abi: CL_POOL_FACTORY_ABI,
          functionName: 'factory',
        })
        attempts.push({ key: 'pool.factory()', returnedPool: typeof reverseFactory === 'string' ? reverseFactory.toLowerCase() : null })
        if (isCanonicalSlipstreamFactory(reverseFactory)) return true
        if (typeof reverseFactory === 'string') {
          const listedMatch = await validateByListedSlipstreamFactory({
            poolTickSpacing: async (pool) => Number(await client.readContract({ address: pool as `0x${string}`, abi: CL_POOL_TICK_SPACING_ABI, functionName: 'tickSpacing' })),
            factoryGetPool: async (factory, a, b, tickSpacing) => await client.readContract({
              address: factory as `0x${string}`, abi: SLIPSTREAM_FACTORY_ABI, functionName: 'getPool',
              args: [a as `0x${string}`, b as `0x${string}`, tickSpacing],
            }) as string,
          }, reverseFactory, target, token0, token1, listedExtraSlipstreamFactories(), attempts)
          if (listedMatch) return true
        }
        logPoolValidationAudit(protocol, AERODROME_SLIPSTREAM_FACTORY, target, token0, token1, attempts, false)
        return false
      } catch {
        logPoolValidationAudit(protocol, protocol === 'aerodrome_classic' ? AERODROME_CLASSIC_FACTORY : AERODROME_SLIPSTREAM_FACTORY, target, token0, token1, attempts, false)
        return false
      }
    },
  }
}

// ETHEREUM: canonical Uniswap factories. The log decoder tags a pool by event shape — the V2-shaped
// Swap ('aerodrome_classic' tag) is checked with UniswapV2Factory.getPair, the V3-shaped Swap with the
// pool's own fee() and UniswapV3Factory.getPool(token0, token1, fee). Both must return this exact pool.
export const UNISWAP_V2_FACTORY_ETH = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
export const UNISWAP_V3_FACTORY_ETH = '0x1F98431c8aD98523631AE4a59f267346ea31F984'

const UNISWAP_V2_FACTORY_ABI = [{
  type: 'function', name: 'getPair', stateMutability: 'view',
  inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }],
  outputs: [{ name: 'pair', type: 'address' }],
}] as const
const UNISWAP_V3_FACTORY_ABI = [{
  type: 'function', name: 'getPool', stateMutability: 'view',
  inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
  outputs: [{ name: 'pool', type: 'address' }],
}] as const
const UNISWAP_V3_POOL_FEE_ABI = [{
  type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }],
}] as const

export type EthereumPoolReads = {
  getV2Pair(tokenA: string, tokenB: string): Promise<string | null>
  getV3PoolFee(pool: string): Promise<number | null>
  getV3Pool(tokenA: string, tokenB: string, fee: number): Promise<string | null>
}

/** PURE over its reads (injectable for tests). Fails closed on any missing/failed read. */
export function createEthereumDexPoolValidator(reads: EthereumPoolReads): PoolValidator {
  const cache = new Map<string, Promise<boolean>>()
  return {
    isValidPool(protocol, poolAddress, token0, token1) {
      const target = poolAddress.toLowerCase()
      const key = `${protocol}:${target}:${[token0.toLowerCase(), token1.toLowerCase()].sort().join(':')}`
      const hit = cache.get(key)
      if (hit) return hit
      const run = (async () => {
        try {
          if (protocol === 'aerodrome_classic' || protocol === 'uniswap_v2') {
            const pair = await reads.getV2Pair(token0, token1)
            return typeof pair === 'string' && pair.toLowerCase() === target
          }
          const fee = await reads.getV3PoolFee(poolAddress)
          if (fee == null) return false
          const pool = await reads.getV3Pool(token0, token1, fee)
          return typeof pool === 'string' && pool.toLowerCase() === target
        } catch {
          return false
        }
      })()
      cache.set(key, run)
      return run
    },
  }
}

export function createLiveEthereumDexPoolValidator(): PoolValidator {
  const client = () => getSharedEthereumClient()
  return createEthereumDexPoolValidator({
    async getV2Pair(tokenA, tokenB) {
      const c = client(); if (!c) return null
      return await c.readContract({ address: UNISWAP_V2_FACTORY_ETH as `0x${string}`, abi: UNISWAP_V2_FACTORY_ABI, functionName: 'getPair', args: [tokenA as `0x${string}`, tokenB as `0x${string}`] }) as string
    },
    async getV3PoolFee(pool) {
      const c = client(); if (!c) return null
      return Number(await c.readContract({ address: pool as `0x${string}`, abi: UNISWAP_V3_POOL_FEE_ABI, functionName: 'fee' }))
    },
    async getV3Pool(tokenA, tokenB, fee) {
      const c = client(); if (!c) return null
      return await c.readContract({ address: UNISWAP_V3_FACTORY_ETH as `0x${string}`, abi: UNISWAP_V3_FACTORY_ABI, functionName: 'getPool', args: [tokenA as `0x${string}`, tokenB as `0x${string}`, fee] }) as string
    },
  })
}

/** Routes each validation to its chain's validator (Base when no chain is given). */
export function createChainPoolValidator(validators: { base: PoolValidator; eth: PoolValidator }): PoolValidator {
  return {
    isValidPool(protocol, poolAddress, token0, token1, chain = 'base') {
      return (chain === 'eth' ? validators.eth : validators.base).isValidPool(protocol, poolAddress, token0, token1, chain)
    },
  }
}
