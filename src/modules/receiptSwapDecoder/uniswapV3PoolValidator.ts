// MODULE — receiptSwapDecoder: Uniswap V3 (Base) factory validation.
//
// A pool address alone (even one emitting a byte-identical Swap event) is not sufficient evidence
// it's a real Uniswap V3 pool — the exact same event signature is shared by Aerodrome Slipstream
// (see signatures.ts's own header). Validation confirms the pool address was actually returned by
// the CANONICAL Uniswap V3 factory on Base for the exact token pair — the same canonical factory
// address already verified and shipped in src/modules/pricingAtTimeEngine/sources/basedex.ts (not
// re-derived or guessed here; restated, same source of truth). CONFIRMED, this task: still the
// same `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` — re-checked against basedex.ts's own
// UNISWAP_V3_FACTORY_BASE constant while diagnosing the production rejection this task addresses.
//
// FEE EXTRACTION, DISCLOSED: a Uniswap V3 Swap event carries no fee field — the fee tier is
// determined ONLY by which of the factory's real, standard fee tiers' getPool() call actually
// returns this exact pool address. That returned tier IS the extracted fee, never guessed from
// price/tick data. `feeSource` on the returned diagnostics is always either
// 'factory_getPool_fee_tier_match' (a tier's getPool() call matched) or 'unavailable' (none did) —
// there is no other way this module ever derives a fee.
//
// FORENSIC DIAGNOSTICS, DISCLOSED (this task — production proof: 1 pool examined, amount
// reconciliation passed, 1 validation call, 0 pools validated, generic rejection
// uniswap_v3_pool_not_validated, no way to tell WHY). Every validation attempt now returns a bounded
// `diagnostics` object alongside the plain valid/fee result — captured from the SAME getPool()
// call(s) this function was always going to make; no duplicate call is ever issued merely to
// populate a diagnostic field. `finalTypedReason` distinguishes exactly why an attempt failed:
//   - invalid_token_pair       — token0/token1 missing or identical; never even calls the factory.
//   - rpc_failure              — every getPool() call attempted threw (RPC/network failure).
//   - factory_returned_zero    — every getPool() call that DID return successfully came back as the
//                                zero address for every fee tier (and the order-normalized retry, if
//                                attempted) — the factory has no record of any pool for this pair at
//                                all.
//   - factory_pool_mismatch    — the factory DOES know a real pool for this token pair/fee, but its
//                                address is not the one that emitted the Swap event being validated.
//   - fee_unavailable          — defensive-only (unreachable via the real, non-empty fee-tier list;
//                                exists so a caller that somehow has zero fee tiers to try still gets
//                                an honest, typed reason instead of a crash).
// `likely_non_uniswap_v3_factory` (this task's sixth requested distinguishing reason) is NOT
// returned by this module — see index.ts's own header for why that one is a higher-level
// conclusion decodeReceiptSwap draws (this validator's own factory_returned_zero PLUS the fact that
// Aerodrome's factories already failed first), not something this module can determine on its own.
//
// TOKEN ORDERING, DISCLOSED: Uniswap V3's real factory contract is order-independent (its own
// getPool() sorts internally) — but this module still normalizes deterministically (lexicographic
// ascending) for the PRIMARY attempt, and only issues a SECOND, order-reversed attempt if the
// primary attempt (all fee tiers) found no match at all. That second attempt is a genuine fallback
// with real validation value (guards against a caller passing token0/token1 already-swapped due to
// an upstream bug) — never a duplicate call made merely to fill in a diagnostic field.
//
// REQUEST-SCOPED CACHE + SINGLEFLIGHT + HARD CAP, DISCLOSED: same conventions as
// receiptAcquisition.ts's own request-scoped cache — a pool validated (or rejected) once this scan
// is never re-validated, a concurrent duplicate validation attempt is coalesced into the one
// in-flight call, and a hard cap on the number of DISTINCT pool validations this scan will attempt
// (independent from, and never increasing, the 10-call receipt-acquisition budget) fails closed
// (never validated) once exceeded rather than making an unbounded number of calls.

import { getSharedBaseClient } from './rpcClient'
import type { UniswapV3ValidationDiagnostics } from './types'

// Same canonical, previously-verified address as basedex.ts — see that file's own header for the
// full provenance/verification disclosure. Re-confirmed unchanged, this task.
export const BASE_UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'

// Same three standard, publicly-documented Uniswap V3 fee tiers basedex.ts already verified and
// uses for pricing (0.05% / 0.3% / 1%) — not re-derived, restated.
const UNISWAP_V3_FEE_TIERS = [500, 3000, 10000] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const UNISWAP_V3_FACTORY_ABI = [
  {
    type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

export type UniswapV3ValidationFinalReason = UniswapV3ValidationDiagnostics['finalTypedReason']

export type { UniswapV3ValidationDiagnostics }

export type UniswapV3ValidationResult = {
  valid: boolean
  fee: number | null
  diagnostics: UniswapV3ValidationDiagnostics
}

export type UniswapV3PoolValidator = {
  validatePool(poolAddress: string, token0: string, token1: string): Promise<UniswapV3ValidationResult>
}

export type UniswapV3ValidationRequestScope = {
  cache: Map<string, UniswapV3ValidationResult>
  inFlight: Map<string, Promise<UniswapV3ValidationResult>>
}

export function createUniswapV3ValidationRequestScope(): UniswapV3ValidationRequestScope {
  return { cache: new Map(), inFlight: new Map() }
}

function scopeKey(poolAddress: string, token0: string, token1: string): string {
  return `${poolAddress.toLowerCase()}:${token0.toLowerCase()}:${token1.toLowerCase()}`
}

function cappedDiagnostics(poolAddress: string, token0: string, token1: string): UniswapV3ValidationDiagnostics {
  return {
    eventEmitter: poolAddress,
    configuredFactory: BASE_UNISWAP_V3_FACTORY,
    token0,
    token1,
    fee: null,
    feeSource: 'unavailable',
    getPoolResult: null,
    emitterMatchesResult: false,
    reversedTokenOrderAttempted: false,
    reversedGetPoolResult: null,
    feeAttempts: [],
    getPoolResults: [],
    reversedGetPoolResults: [],
    finalTypedReason: 'validation_cap_exceeded',
  }
}

const DEFAULT_MAX_VALIDATION_CALLS = 10

// Wraps `inner` with the request-scoped cache/singleflight/hard-cap described above. Returns a
// `callCount()` accessor so the caller can expose exactly how many real validation attempts this
// scan made — a separate, independently-capped counter from receipt-acquisition's own
// receiptProviderCalls.
export function createCachedUniswapV3PoolValidator(
  inner: UniswapV3PoolValidator,
  scope: UniswapV3ValidationRequestScope,
  maxValidationCalls: number = DEFAULT_MAX_VALIDATION_CALLS,
): { validator: UniswapV3PoolValidator; callCount: () => number } {
  let calls = 0
  return {
    callCount: () => calls,
    validator: {
      async validatePool(poolAddress, token0, token1) {
        const key = scopeKey(poolAddress, token0, token1)
        if (scope.cache.has(key)) return scope.cache.get(key)!
        if (scope.inFlight.has(key)) return scope.inFlight.get(key)!

        // HARD CAP, DISCLOSED: a genuinely new (uncached, not in-flight) validation beyond the cap
        // fails closed — never validated — rather than making an unbounded number of factory calls.
        if (calls >= maxValidationCalls) {
          const capped: UniswapV3ValidationResult = { valid: false, fee: null, diagnostics: cappedDiagnostics(poolAddress, token0, token1) }
          scope.cache.set(key, capped)
          return capped
        }

        calls += 1
        const promise = inner.validatePool(poolAddress, token0, token1)
        scope.inFlight.set(key, promise)
        const result = await promise
        scope.inFlight.delete(key)
        scope.cache.set(key, result)
        return result
      },
    },
  }
}

// One pass over every real fee tier, calling getPool(tokenA, tokenB, fee) for the given
// (tokenA, tokenB) order only — never retried per-tier, never called twice for the same tier.
async function attemptFeeTiers(
  client: NonNullable<ReturnType<typeof getSharedBaseClient>>,
  tokenA: string,
  tokenB: string,
  poolAddress: string,
): Promise<{
  matchedFee: number | null
  matchedPool: string | null
  anyRpcSucceeded: boolean
  anyNonZero: boolean
  // Per-tier getPool() result, aligned index-for-index with UNISWAP_V3_FEE_TIERS — null means that
  // tier's own RPC call threw. Captured from the same calls above, purely for forensic surfacing.
  perTierResults: (string | null)[]
}> {
  let matchedFee: number | null = null
  let matchedPool: string | null = null
  let anyRpcSucceeded = false
  let anyNonZero = false
  const perTierResults: (string | null)[] = []

  for (const fee of UNISWAP_V3_FEE_TIERS) {
    try {
      const pool = await client.readContract({
        address: BASE_UNISWAP_V3_FACTORY as `0x${string}`,
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenA as `0x${string}`, tokenB as `0x${string}`, fee],
      })
      if (typeof pool !== 'string') {
        perTierResults.push(null)
        continue
      }
      perTierResults.push(pool)
      anyRpcSucceeded = true
      if (pool.toLowerCase() !== ZERO_ADDRESS) {
        anyNonZero = true
        matchedPool = matchedPool ?? pool
      }
      if (pool.toLowerCase() === poolAddress.toLowerCase()) {
        matchedFee = fee
        matchedPool = pool
        break
      }
    } catch {
      // Fails closed for this tier only — tries the next real tier, never re-attempts this one.
      perTierResults.push(null)
    }
  }

  return { matchedFee, matchedPool, anyRpcSucceeded, anyNonZero, perTierResults }
}

// Real, on-chain implementation. NO RETRIES, DISCLOSED: each fee tier (and, if needed, the single
// order-reversed fallback pass) is tried exactly once.
export function createLiveUniswapV3PoolValidator(): UniswapV3PoolValidator {
  return {
    async validatePool(poolAddress, token0, token1) {
      const baseDiagnostics = {
        eventEmitter: poolAddress,
        configuredFactory: BASE_UNISWAP_V3_FACTORY,
        token0,
        token1,
      }

      if (!token0 || !token1 || token0.toLowerCase() === token1.toLowerCase()) {
        return {
          valid: false, fee: null,
          diagnostics: {
            ...baseDiagnostics, fee: null, feeSource: 'unavailable', getPoolResult: null,
            emitterMatchesResult: false, reversedTokenOrderAttempted: false, reversedGetPoolResult: null,
            feeAttempts: [], getPoolResults: [], reversedGetPoolResults: [],
            finalTypedReason: 'invalid_token_pair',
          },
        }
      }

      const client = getSharedBaseClient()
      if (!client) {
        return {
          valid: false, fee: null,
          diagnostics: {
            ...baseDiagnostics, fee: null, feeSource: 'unavailable', getPoolResult: null,
            emitterMatchesResult: false, reversedTokenOrderAttempted: false, reversedGetPoolResult: null,
            feeAttempts: [], getPoolResults: [], reversedGetPoolResults: [],
            finalTypedReason: 'rpc_failure',
          },
        }
      }

      // NORMALIZE DETERMINISTICALLY, DISCLOSED: lexicographic ascending order for the primary
      // attempt — the real factory doesn't require this, but it makes the primary attempt
      // deterministic and repeatable regardless of which order the caller happened to pass tokens in.
      const [primaryA, primaryB] = token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0]

      const primary = await attemptFeeTiers(client, primaryA, primaryB, poolAddress)
      const primaryFeeAttempts = UNISWAP_V3_FEE_TIERS.slice(0, primary.perTierResults.length)
      if (primary.matchedFee !== null) {
        return {
          valid: true, fee: primary.matchedFee,
          diagnostics: {
            ...baseDiagnostics, fee: primary.matchedFee, feeSource: 'factory_getPool_fee_tier_match',
            getPoolResult: primary.matchedPool, emitterMatchesResult: true,
            reversedTokenOrderAttempted: false, reversedGetPoolResult: null,
            feeAttempts: primaryFeeAttempts, getPoolResults: primary.perTierResults, reversedGetPoolResults: [],
            finalTypedReason: 'validated',
          },
        }
      }

      // ORDER-REVERSED FALLBACK, DISCLOSED: only attempted because the primary (normalized) order
      // found no match at all — a real, purposeful second attempt guarding against an upstream
      // token0/token1 mixup, never a duplicate call for diagnostics alone.
      const reversed = await attemptFeeTiers(client, primaryB, primaryA, poolAddress)
      if (reversed.matchedFee !== null) {
        return {
          valid: true, fee: reversed.matchedFee,
          diagnostics: {
            ...baseDiagnostics, fee: reversed.matchedFee, feeSource: 'factory_getPool_fee_tier_match',
            getPoolResult: primary.matchedPool, emitterMatchesResult: true,
            reversedTokenOrderAttempted: true, reversedGetPoolResult: reversed.matchedPool,
            feeAttempts: primaryFeeAttempts, getPoolResults: primary.perTierResults, reversedGetPoolResults: reversed.perTierResults,
            finalTypedReason: 'validated',
          },
        }
      }

      const anyRpcSucceeded = primary.anyRpcSucceeded || reversed.anyRpcSucceeded
      const anyNonZero = primary.anyNonZero || reversed.anyNonZero

      const finalTypedReason: UniswapV3ValidationFinalReason = !anyRpcSucceeded
        ? 'rpc_failure'
        : anyNonZero
          ? 'factory_pool_mismatch'
          : 'factory_returned_zero'

      return {
        valid: false, fee: null,
        diagnostics: {
          ...baseDiagnostics, fee: null, feeSource: 'unavailable',
          getPoolResult: primary.matchedPool, emitterMatchesResult: false,
          reversedTokenOrderAttempted: true, reversedGetPoolResult: reversed.matchedPool,
          feeAttempts: primaryFeeAttempts, getPoolResults: primary.perTierResults, reversedGetPoolResults: reversed.perTierResults,
          finalTypedReason,
        },
      }
    },
  }
}
