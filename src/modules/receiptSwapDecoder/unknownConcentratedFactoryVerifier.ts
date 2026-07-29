// MODULE — receiptSwapDecoder: forensic verification of an UNKNOWN Base concentrated-liquidity
// factory, consulted only after concentratedPoolEmitterFingerprint.ts has already classified an
// emitter's claimed factory() as 'unknown_concentrated_factory' — the exact production case this
// task addresses: emitter 0x7f31b371ac675bca3357fd9c26854fed067400c0 claims factory()
// 0xade65c38cd4849adba595a4323a8c7ddfe89716a, with matching token0/token1/fee=10000, while both
// Uniswap V3 and Aerodrome Slipstream validation already failed. This module answers "does the
// claimed factory genuinely own this pool" — WITHOUT adding it to the verified registry, and
// WITHOUT treating any positive result here as license to decode/replay the swap.
//
// SHADOW/FORENSIC ONLY, DISCLOSED: this module never returns anything consumed by decodeReceiptSwap
// or FIFO/pricing — it exists purely to produce a bounded, logged diagnostic. A caller that gets
// finalTypedReason === 'factory_created_emitter' back from this module still must NOT decode or
// replay the swap on that basis alone (see walletScanShadowWiring.ts's own wiring — this module's
// result is only ever logged, never returned to a decode path).
//
// DISCOVERY METHOD DISCIPLINE, DISCLOSED: the PRIMARY discovery attempt is always the standard
// Uniswap-V3-shaped getPool(token0, token1, fee) — the same signature already verified and used by
// uniswapV3PoolValidator.ts. A SECOND, alternate discovery method (poolByPair(token0, token1)) is
// only ever attempted when (a) the primary attempt genuinely failed/reverted AND (b) offline
// bytecode-selector probing of the factory's own already-fetched runtime code proves the factory
// actually implements that selector — never a blind guess-call against an interface the factory
// never advertised, and never a duplicate of the primary call.
//
// NO PROOF FROM CODE SIMILARITY ALONE, DISCLOSED: `knownImplementationCodeMatch`/`proposedProtocol`
// are purely informational annotations, computed from `KNOWN_CONCENTRATED_POOL_IMPLEMENTATION_CODE_HASHES`
// (an explicit, independently-populated registry of ALREADY-VERIFIED pool bytecode hashes — never
// guessed). A pool's runtime code hash matching (or not matching) a known implementation NEVER by
// itself upgrades or downgrades `finalTypedReason`'s core address-match verdict
// (factory_created_emitter / factory_returned_different_pool / factory_returned_zero) — the ONE
// exception is `pool_code_mismatch`, which exists specifically to flag (not silently accept) the
// case where the address-match evidence looks positive (factory's own getPool()/poolByPair() DOES
// return this exact emitter) but the pool's own bytecode doesn't resemble ANY already-verified
// concentrated-pool implementation — an honest "the address matches, but I don't trust the code"
// result, not a promotion to a confirmed protocol.
//
// NO EXPLORER LABELS / SYMBOL GUESSES / SWAP-TOPIC INFERENCE, DISCLOSED: every field this module
// produces comes from on-chain contract reads (getPool/poolByPair/bytecode) against the CLAIMED
// factory and the pool it discovers — never from a block explorer label, a token symbol guess, or
// the shape of the original Swap event log (which this module never even receives).
//
// BOUNDED RPC, DISCLOSED: at most 4 new factory-verification RPC calls per examined emitter --
// (1) claimed factory's own runtime bytecode, (2) the primary getPool() discovery attempt,
// (3) the poolByPair() fallback ONLY when selector-probing proved support and (2) failed,
// (4) the discovered pool's own runtime bytecode (only when a pool was actually discovered). No
// retries — each of these is attempted exactly once.
//
// DOES NOT ADD TO THE VERIFIED REGISTRY, DISCLOSED: this pass never mutates
// concentratedPoolEmitterFingerprint.ts's VERIFIED_BASE_CONCENTRATED_FACTORIES — a positive
// factory_created_emitter result here is forensic evidence for a human to review, never an
// automatic registry promotion.
//
// REQUEST-SCOPED CACHE + SINGLEFLIGHT, DISCLOSED: same conventions as every other validator in this
// module set — an (emitter, claimed factory, token pair, fee) tuple verified once this scan is
// never re-verified, and a concurrent duplicate attempt coalesces into the one in-flight call.

import { keccak256, toBytes } from 'viem'
import { getSharedBaseClient } from './rpcClient'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const FACTORY_DISCOVERY_ABI = [
  {
    type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
  {
    type: 'function', name: 'poolByPair', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

export type KnownPoolImplementationEntry = { codeHash: string; protocol: string }

// EXPLICIT, INDEPENDENTLY-POPULATED REGISTRY, DISCLOSED: intentionally empty in this pass — real
// runtime-bytecode hashes for Uniswap V3's / Aerodrome Slipstream's own pool implementations must be
// independently verified on-chain before being added here (see this file's own "no proof from code
// similarity alone" disclosure); never seeded with a guessed or assumed hash.
export const KNOWN_CONCENTRATED_POOL_IMPLEMENTATION_CODE_HASHES: readonly KnownPoolImplementationEntry[] = []

export type UnknownFactoryDiscoveryMethod = 'getPool' | 'poolByPair' | null

export type UnknownConcentratedFactoryVerificationFinalReason =
  | 'factory_created_emitter'
  | 'factory_returned_zero'
  | 'factory_returned_different_pool'
  | 'unsupported_factory_interface'
  | 'factory_rpc_failure'
  | 'pool_code_mismatch'

export type UnknownConcentratedFactoryVerificationDiagnostics = {
  txHash: string
  eventEmitter: string
  claimedFactory: string
  factoryCodeHash: string | null
  discoveryMethod: UnknownFactoryDiscoveryMethod
  discoveredPool: string | null
  emitterMatchesDiscoveredPool: boolean | null
  poolCodeHash: string | null
  knownImplementationCodeMatch: boolean | null
  proposedProtocol: string | null
  confidence: 'high' | 'medium' | 'low'
  finalTypedReason: UnknownConcentratedFactoryVerificationFinalReason
}

export type UnknownConcentratedFactoryVerifier = {
  verify(
    txHash: string, eventEmitter: string, claimedFactory: string, token0: string, token1: string, fee: number,
  ): Promise<UnknownConcentratedFactoryVerificationDiagnostics>
}

export type RawUnknownFactoryVerificationReads = {
  txHash: string
  eventEmitter: string
  claimedFactory: string
  factoryCodeHash: string | null
  discoveryMethod: UnknownFactoryDiscoveryMethod
  discoveredPool: string | null
  poolCodeHash: string | null
}

// PURE, DISCLOSED: all classification logic lives here, independent of how the raw reads were
// obtained — directly unit-testable (including this task's own production scenario) without a live
// RPC client. `knownImplementations` defaults to the real, explicit registry above but is injectable
// for testing both the match and no-match branches.
export function classifyUnknownFactoryVerification(
  input: RawUnknownFactoryVerificationReads,
  knownImplementations: readonly KnownPoolImplementationEntry[] = KNOWN_CONCENTRATED_POOL_IMPLEMENTATION_CODE_HASHES,
): UnknownConcentratedFactoryVerificationDiagnostics {
  const eventEmitter = input.eventEmitter.toLowerCase()
  const claimedFactory = input.claimedFactory.toLowerCase()
  const discoveredPool = input.discoveredPool ? input.discoveredPool.toLowerCase() : null

  const base = {
    txHash: input.txHash, eventEmitter, claimedFactory,
    factoryCodeHash: input.factoryCodeHash, poolCodeHash: input.poolCodeHash,
  }

  // TOTAL FAILURE, DISCLOSED: no factory bytecode AND no discovery method ever succeeded at all —
  // honest "learned nothing", never a false 'unsupported_factory_interface' guess.
  if (!input.factoryCodeHash && !input.discoveryMethod) {
    return {
      ...base, discoveryMethod: null, discoveredPool: null, emitterMatchesDiscoveredPool: null,
      knownImplementationCodeMatch: null, proposedProtocol: null, confidence: 'low',
      finalTypedReason: 'factory_rpc_failure',
    }
  }

  if (!input.discoveryMethod) {
    return {
      ...base, discoveryMethod: null, discoveredPool: null, emitterMatchesDiscoveredPool: null,
      knownImplementationCodeMatch: null, proposedProtocol: null, confidence: 'low',
      finalTypedReason: 'unsupported_factory_interface',
    }
  }

  if (discoveredPool === null) {
    return {
      ...base, discoveryMethod: input.discoveryMethod, discoveredPool: null, emitterMatchesDiscoveredPool: null,
      knownImplementationCodeMatch: null, proposedProtocol: null, confidence: 'high',
      finalTypedReason: 'factory_returned_zero',
    }
  }

  const emitterMatchesDiscoveredPool = discoveredPool === eventEmitter

  if (!emitterMatchesDiscoveredPool) {
    return {
      ...base, discoveryMethod: input.discoveryMethod, discoveredPool, emitterMatchesDiscoveredPool: false,
      knownImplementationCodeMatch: null, proposedProtocol: null, confidence: 'high',
      finalTypedReason: 'factory_returned_different_pool',
    }
  }

  // ADDRESS MATCH CONFIRMED, DISCLOSED: the claimed factory's own discovery call returned exactly
  // this emitter. Code-hash comparison below is informational-only (see this file's own header) —
  // it can flag `pool_code_mismatch`, but a MATCH never upgrades this beyond 'factory_created_emitter'.
  let knownImplementationCodeMatch: boolean | null = null
  let proposedProtocol: string | null = null
  if (input.poolCodeHash) {
    const found = knownImplementations.find((entry) => entry.codeHash.toLowerCase() === input.poolCodeHash!.toLowerCase())
    knownImplementationCodeMatch = Boolean(found)
    proposedProtocol = found ? found.protocol : null
  }

  if (input.poolCodeHash && knownImplementationCodeMatch === false) {
    return {
      ...base, discoveryMethod: input.discoveryMethod, discoveredPool, emitterMatchesDiscoveredPool: true,
      knownImplementationCodeMatch: false, proposedProtocol: null, confidence: 'low',
      finalTypedReason: 'pool_code_mismatch',
    }
  }

  return {
    ...base, discoveryMethod: input.discoveryMethod, discoveredPool, emitterMatchesDiscoveredPool: true,
    knownImplementationCodeMatch, proposedProtocol,
    confidence: input.poolCodeHash ? 'high' : 'medium',
    finalTypedReason: 'factory_created_emitter',
  }
}

async function attemptDiscovery(
  client: NonNullable<ReturnType<typeof getSharedBaseClient>>,
  factory: string, token0: string, token1: string, fee: number, functionName: 'getPool' | 'poolByPair',
): Promise<{ succeeded: boolean; pool: string | null }> {
  try {
    const result = functionName === 'getPool'
      ? await client.readContract({
          address: factory as `0x${string}`, abi: FACTORY_DISCOVERY_ABI, functionName: 'getPool',
          args: [token0 as `0x${string}`, token1 as `0x${string}`, fee],
        })
      : await client.readContract({
          address: factory as `0x${string}`, abi: FACTORY_DISCOVERY_ABI, functionName: 'poolByPair',
          args: [token0 as `0x${string}`, token1 as `0x${string}`],
        })
    if (typeof result !== 'string') return { succeeded: false, pool: null }
    return { succeeded: true, pool: result.toLowerCase() === ZERO_ADDRESS ? null : result.toLowerCase() }
  } catch {
    // Fails closed for this one discovery attempt only — never retried.
    return { succeeded: false, pool: null }
  }
}

// Real, on-chain implementation. NO RETRIES, DISCLOSED: each read below is attempted exactly once,
// bounded to at most 4 total factory-verification RPC calls (see this file's own header).
export function createLiveUnknownConcentratedFactoryVerifier(): UnknownConcentratedFactoryVerifier {
  return {
    async verify(txHash, eventEmitter, claimedFactory, token0, token1, fee) {
      const client = getSharedBaseClient()
      if (!client) {
        return classifyUnknownFactoryVerification({
          txHash, eventEmitter, claimedFactory, factoryCodeHash: null, discoveryMethod: null,
          discoveredPool: null, poolCodeHash: null,
        })
      }

      // CALL 1 of 4: the claimed factory's own runtime bytecode — also reused (no extra call) for
      // the offline poolByPair selector-support probe below.
      let factoryCode: string | null = null
      try {
        factoryCode = (await client.getBytecode({ address: claimedFactory as `0x${string}` })) ?? null
      } catch {
        factoryCode = null
      }
      const factoryCodeHash = factoryCode ? keccak256(factoryCode as `0x${string}`) : null

      // CALL 2 of 4: the primary, standard Uniswap-V3-shaped discovery attempt.
      const primary = await attemptDiscovery(client, claimedFactory, token0, token1, fee, 'getPool')
      let discoveryMethod: UnknownFactoryDiscoveryMethod = primary.succeeded ? 'getPool' : null
      let discoveredPool = primary.pool

      // CALL 3 of 4 (ONLY when the primary genuinely failed AND offline selector probing of the
      // already-fetched bytecode proves the factory implements poolByPair): the fallback discovery
      // attempt — a real, purposeful second attempt, never a blind guess against an unadvertised
      // interface.
      if (!primary.succeeded && factoryCode) {
        const poolByPairSelector = keccak256(toBytes('poolByPair(address,address)')).slice(2, 10)
        if (factoryCode.toLowerCase().includes(poolByPairSelector)) {
          const fallback = await attemptDiscovery(client, claimedFactory, token0, token1, fee, 'poolByPair')
          if (fallback.succeeded) {
            discoveryMethod = 'poolByPair'
            discoveredPool = fallback.pool
          }
        }
      }

      // CALL 4 of 4 (only when a pool was actually discovered): the discovered pool's own runtime
      // bytecode, for the informational code-hash comparison described in this file's own header.
      let poolCodeHash: string | null = null
      if (discoveredPool) {
        try {
          const code = await client.getBytecode({ address: discoveredPool as `0x${string}` })
          poolCodeHash = code ? keccak256(code as `0x${string}`) : null
        } catch {
          poolCodeHash = null
        }
      }

      return classifyUnknownFactoryVerification({
        txHash, eventEmitter, claimedFactory, factoryCodeHash, discoveryMethod, discoveredPool, poolCodeHash,
      })
    },
  }
}

export type UnknownFactoryVerificationRequestScope = {
  cache: Map<string, UnknownConcentratedFactoryVerificationDiagnostics>
  inFlight: Map<string, Promise<UnknownConcentratedFactoryVerificationDiagnostics>>
}

export function createUnknownFactoryVerificationRequestScope(): UnknownFactoryVerificationRequestScope {
  return { cache: new Map(), inFlight: new Map() }
}

function scopeKey(emitter: string, factory: string, token0: string, token1: string, fee: number): string {
  return `${emitter.toLowerCase()}:${factory.toLowerCase()}:${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}`
}

// Wraps `inner` with the request-scoped cache/singleflight described above. Returns a `callCount()`
// accessor so a caller can expose exactly how many real verification attempts this scan made.
export function createCachedUnknownConcentratedFactoryVerifier(
  inner: UnknownConcentratedFactoryVerifier,
  scope: UnknownFactoryVerificationRequestScope,
): { verifier: UnknownConcentratedFactoryVerifier; callCount: () => number } {
  let calls = 0
  return {
    callCount: () => calls,
    verifier: {
      async verify(txHash, eventEmitter, claimedFactory, token0, token1, fee) {
        const key = scopeKey(eventEmitter, claimedFactory, token0, token1, fee)
        if (scope.cache.has(key)) return scope.cache.get(key)!
        if (scope.inFlight.has(key)) return scope.inFlight.get(key)!

        calls += 1
        const promise = inner.verify(txHash, eventEmitter, claimedFactory, token0, token1, fee)
        scope.inFlight.set(key, promise)
        const result = await promise
        scope.inFlight.delete(key)
        scope.cache.set(key, result)
        return result
      },
    },
  }
}
