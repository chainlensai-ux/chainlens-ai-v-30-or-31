// MODULE — receiptSwapDecoder: bounded, shadow-only fingerprinting of a concentrated-liquidity Swap
// event's own emitter contract, used ONLY after the canonical Uniswap V3 factory has already failed
// to validate that emitter (see uniswapV3PoolValidator.ts) — the exact production case this task
// addresses: a real concentrated pool (eventEmitter 0x7f31...00c0, Base WETH / 0x5576...37ea) whose
// swap signs and transfer amounts reconcile exactly, but the canonical Uniswap V3 factory returns a
// DIFFERENT pool at fee 10000, and Aerodrome validation already failed too. This module answers
// "what IS this emitter, then" — never by re-guessing from the Swap event's topic0 shape (that
// signature is shared by multiple concentrated-liquidity protocols, see signatures.ts's own
// header), but by reading the pool CONTRACT's own claimed identity and comparing it against an
// explicit, already-verified registry of real Base concentrated-liquidity factories.
//
// DO NOT INFER FROM TOPIC0, DISCLOSED: this module never receives or reads the Swap event's
// topic0/log shape at all — it operates purely on the emitter's on-chain contract surface
// (factory()/token0()/token1()/fee()/runtime bytecode), so it is structurally incapable of
// resurrecting the "topic0 alone implies protocol" mistake this whole module set has been
// disclosed as guarding against from the start (uniswapV3Leg.ts's own header).
//
// DO NOT ACCEPT UNKNOWN FACTORIES, DISCLOSED: a factory address that ISN'T one of the explicit,
// already-verified entries in VERIFIED_BASE_CONCENTRATED_FACTORIES below is never treated as a
// known protocol — it fails closed as 'unknown_concentrated_factory', never guessed or assumed to
// be "probably fine". The registry currently holds exactly one entry: Aerodrome Slipstream's real,
// previously-verified Base factory (poolValidator.ts's own AERODROME_SLIPSTREAM_FACTORY, restated
// here, not re-derived) — Uniswap V3's own factory is deliberately NOT in this registry: this
// module is only ever consulted after Uniswap V3's OWN factory.getPool() has already failed to
// validate this exact emitter (see the wiring in walletScanShadowWiring.ts), so an emitter that
// nonetheless claims factory() === Uniswap's address would be self-contradictory evidence, not
// trustworthy confirmation — it correctly falls through to 'unknown_concentrated_factory' below
// rather than being upgraded to a false "verified" result.
//
// BOUNDED RPC, DISCLOSED: exactly 4 "fingerprint" contract-level reads per examined emitter --
// factory(), token0(), token1(), fee() -- each attempted exactly once, no retries. Runtime bytecode
// hashing is a separate, always-attempted eth_getCode call (a distinct RPC method, not a contract
// read against the pool's own ABI) — not counted against the 4-call fingerprint budget, but still a
// single bounded call, never retried.
//
// REQUEST-SCOPED CACHE + SINGLEFLIGHT, DISCLOSED: same conventions as poolValidator.ts /
// uniswapV3PoolValidator.ts — an emitter fingerprinted (or attempted) once this scan is never
// re-fingerprinted, and a concurrent duplicate attempt coalesces into the one in-flight call.
//
// NO RECEIPT-BUDGET INCREASE, DISCLOSED: this module never fetches a receipt — it is only ever
// invoked (see walletScanShadowWiring.ts) for a candidate whose receipt logs are already in hand
// from the existing, unchanged 10-call receipt-acquisition budget.

import { keccak256 } from 'viem'
import { getSharedBaseClient } from './rpcClient'
import { AERODROME_SLIPSTREAM_FACTORY } from './poolValidator'

export type ConcentratedFactoryRegistryEntry = { factory: string; protocol: string }

// EXPLICIT, VERIFIED REGISTRY, DISCLOSED: restates already-verified constants (never re-derived) —
// see this file's own header for why Uniswap V3's factory is deliberately excluded here.
export const VERIFIED_BASE_CONCENTRATED_FACTORIES: readonly ConcentratedFactoryRegistryEntry[] = [
  { factory: AERODROME_SLIPSTREAM_FACTORY, protocol: 'aerodrome_slipstream' },
]

export type ConcentratedEmitterFingerprintFinalReason =
  | 'verified_non_uniswap_factory'
  | 'unknown_concentrated_factory'
  | 'factory_method_unavailable'
  | 'token_pair_mismatch'
  | 'emitter_rpc_failure'

export type ConcentratedEmitterFingerprintDiagnostics = {
  txHash: string
  eventEmitter: string
  emitterFactory: string | null
  emitterToken0: string | null
  emitterToken1: string | null
  emitterFee: number | null
  runtimeCodeHash: string | null
  matchedProtocol: string | null
  matchedFactory: string | null
  tokenPairMatches: boolean | null
  finalTypedReason: ConcentratedEmitterFingerprintFinalReason
}

export type ConcentratedPoolEmitterFingerprinter = {
  fingerprint(txHash: string, emitter: string, expectedToken0: string, expectedToken1: string): Promise<ConcentratedEmitterFingerprintDiagnostics>
}

const POOL_ABI = [
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }] },
] as const

async function readPoolMethod(
  client: NonNullable<ReturnType<typeof getSharedBaseClient>>,
  emitter: string,
  functionName: 'factory' | 'token0' | 'token1' | 'fee',
): Promise<string | number | null> {
  try {
    const result = await client.readContract({ address: emitter as `0x${string}`, abi: POOL_ABI, functionName })
    if (typeof result === 'string' || typeof result === 'number') return result
    if (typeof result === 'bigint') return Number(result)
    return null
  } catch {
    // Fails closed for this one method only — never retried, never blocks the other 3 reads.
    return null
  }
}

function emptyDiagnostics(
  txHash: string, emitter: string, finalTypedReason: ConcentratedEmitterFingerprintFinalReason,
): ConcentratedEmitterFingerprintDiagnostics {
  return {
    txHash, eventEmitter: emitter.toLowerCase(),
    emitterFactory: null, emitterToken0: null, emitterToken1: null, emitterFee: null, runtimeCodeHash: null,
    matchedProtocol: null, matchedFactory: null, tokenPairMatches: null, finalTypedReason,
  }
}

export type RawEmitterFingerprintReads = {
  txHash: string
  emitter: string
  expectedToken0: string
  expectedToken1: string
  factoryRaw: string | null
  token0Raw: string | null
  token1Raw: string | null
  feeRaw: number | null
  runtimeCodeHash: string | null
}

// PURE, DISCLOSED: all classification logic lives here, independent of how the raw reads were
// obtained — makes the typed-reason decision tree (and this task's own production scenario)
// directly unit-testable without a live RPC client. createLiveConcentratedPoolEmitterFingerprinter
// below is the only caller in production; it just gathers the raw reads first.
export function classifyEmitterFingerprint(input: RawEmitterFingerprintReads): ConcentratedEmitterFingerprintDiagnostics {
  const { txHash, emitter, expectedToken0, expectedToken1, factoryRaw, token0Raw, token1Raw, feeRaw, runtimeCodeHash } = input
  const emitterFactory = factoryRaw ? factoryRaw.toLowerCase() : null
  const emitterToken0 = token0Raw ? token0Raw.toLowerCase() : null
  const emitterToken1 = token1Raw ? token1Raw.toLowerCase() : null
  const emitterFee = typeof feeRaw === 'number' ? feeRaw : null

  if (!factoryRaw && !token0Raw && !token1Raw && feeRaw === null && !runtimeCodeHash) {
    // Every single attempted call failed — the emitter is real evidence of nothing, an honest
    // total-RPC-failure result rather than a false 'unknown_concentrated_factory' guess.
    return emptyDiagnostics(txHash, emitter, 'emitter_rpc_failure')
  }

  if (!emitterFactory) {
    return {
      txHash, eventEmitter: emitter.toLowerCase(), emitterFactory: null, emitterToken0, emitterToken1, emitterFee,
      runtimeCodeHash, matchedProtocol: null, matchedFactory: null, tokenPairMatches: null,
      finalTypedReason: 'factory_method_unavailable',
    }
  }

  let tokenPairMatches: boolean | null = null
  if (emitterToken0 && emitterToken1) {
    const expected = new Set([expectedToken0.toLowerCase(), expectedToken1.toLowerCase()])
    const actual = new Set([emitterToken0, emitterToken1])
    tokenPairMatches = expected.size === actual.size && [...expected].every((t) => actual.has(t))
  }

  if (tokenPairMatches === false) {
    return {
      txHash, eventEmitter: emitter.toLowerCase(), emitterFactory, emitterToken0, emitterToken1, emitterFee,
      runtimeCodeHash, matchedProtocol: null, matchedFactory: null, tokenPairMatches,
      finalTypedReason: 'token_pair_mismatch',
    }
  }

  const registryMatch = VERIFIED_BASE_CONCENTRATED_FACTORIES.find((entry) => entry.factory.toLowerCase() === emitterFactory)
  if (registryMatch) {
    return {
      txHash, eventEmitter: emitter.toLowerCase(), emitterFactory, emitterToken0, emitterToken1, emitterFee,
      runtimeCodeHash, matchedProtocol: registryMatch.protocol, matchedFactory: registryMatch.factory.toLowerCase(),
      tokenPairMatches, finalTypedReason: 'verified_non_uniswap_factory',
    }
  }

  return {
    txHash, eventEmitter: emitter.toLowerCase(), emitterFactory, emitterToken0, emitterToken1, emitterFee,
    runtimeCodeHash, matchedProtocol: null, matchedFactory: null, tokenPairMatches,
    finalTypedReason: 'unknown_concentrated_factory',
  }
}

// Real, on-chain implementation. NO RETRIES, DISCLOSED: each of the 4 fingerprint reads (and the
// separate runtime-bytecode fetch) is attempted exactly once.
export function createLiveConcentratedPoolEmitterFingerprinter(): ConcentratedPoolEmitterFingerprinter {
  return {
    async fingerprint(txHash, emitter, expectedToken0, expectedToken1) {
      const client = getSharedBaseClient()
      if (!client) return emptyDiagnostics(txHash, emitter, 'emitter_rpc_failure')

      const [factoryRaw, token0Raw, token1Raw, feeRaw] = await Promise.all([
        readPoolMethod(client, emitter, 'factory'),
        readPoolMethod(client, emitter, 'token0'),
        readPoolMethod(client, emitter, 'token1'),
        readPoolMethod(client, emitter, 'fee'),
      ])

      let runtimeCodeHash: string | null = null
      try {
        const code = await client.getBytecode({ address: emitter as `0x${string}` })
        runtimeCodeHash = code ? keccak256(code) : null
      } catch {
        runtimeCodeHash = null
      }

      return classifyEmitterFingerprint({
        txHash, emitter, expectedToken0, expectedToken1,
        factoryRaw: typeof factoryRaw === 'string' ? factoryRaw : null,
        token0Raw: typeof token0Raw === 'string' ? token0Raw : null,
        token1Raw: typeof token1Raw === 'string' ? token1Raw : null,
        feeRaw: typeof feeRaw === 'number' ? feeRaw : null,
        runtimeCodeHash,
      })
    },
  }
}

export type ConcentratedFingerprintRequestScope = {
  cache: Map<string, ConcentratedEmitterFingerprintDiagnostics>
  inFlight: Map<string, Promise<ConcentratedEmitterFingerprintDiagnostics>>
}

export function createConcentratedFingerprintRequestScope(): ConcentratedFingerprintRequestScope {
  return { cache: new Map(), inFlight: new Map() }
}

function scopeKey(emitter: string, token0: string, token1: string): string {
  return `${emitter.toLowerCase()}:${token0.toLowerCase()}:${token1.toLowerCase()}`
}

// Wraps `inner` with the request-scoped cache/singleflight described above. Returns a `callCount()`
// accessor so a caller can expose exactly how many real fingerprint attempts this scan made.
export function createCachedConcentratedPoolEmitterFingerprinter(
  inner: ConcentratedPoolEmitterFingerprinter,
  scope: ConcentratedFingerprintRequestScope,
): { fingerprinter: ConcentratedPoolEmitterFingerprinter; callCount: () => number } {
  let calls = 0
  return {
    callCount: () => calls,
    fingerprinter: {
      async fingerprint(txHash, emitter, expectedToken0, expectedToken1) {
        const key = scopeKey(emitter, expectedToken0, expectedToken1)
        if (scope.cache.has(key)) return scope.cache.get(key)!
        if (scope.inFlight.has(key)) return scope.inFlight.get(key)!

        calls += 1
        const promise = inner.fingerprint(txHash, emitter, expectedToken0, expectedToken1)
        scope.inFlight.set(key, promise)
        const result = await promise
        scope.inFlight.delete(key)
        scope.cache.set(key, result)
        return result
      },
    },
  }
}
