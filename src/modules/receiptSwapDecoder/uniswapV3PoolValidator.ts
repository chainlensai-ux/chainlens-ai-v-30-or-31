// MODULE — receiptSwapDecoder: Uniswap V3 (Base) factory validation.
//
// A pool address alone (even one emitting a byte-identical Swap event) is not sufficient evidence
// it's a real Uniswap V3 pool — the exact same event signature is shared by Aerodrome Slipstream
// (see signatures.ts's own header). Validation confirms the pool address was actually returned by
// the CANONICAL Uniswap V3 factory on Base for the exact token pair — the same canonical factory
// address already verified and shipped in src/modules/pricingAtTimeEngine/sources/basedex.ts (not
// re-derived or guessed here; restated, same source of truth).
//
// FEE EXTRACTION, DISCLOSED: a Uniswap V3 Swap event carries no fee field — the fee tier is
// determined ONLY by which of the factory's real, standard fee tiers' getPool() call actually
// returns this exact pool address. That returned tier IS the extracted fee, never guessed from
// price/tick data.
//
// REQUEST-SCOPED CACHE + SINGLEFLIGHT + HARD CAP, DISCLOSED: same conventions as
// receiptAcquisition.ts's own request-scoped cache — a pool validated (or rejected) once this scan
// is never re-validated, a concurrent duplicate validation attempt is coalesced into the one
// in-flight call, and a hard cap on the number of DISTINCT pool validations this scan will attempt
// (independent from, and never increasing, the 10-call receipt-acquisition budget) fails closed
// (never validated) once exceeded rather than making an unbounded number of calls.

import { getSharedBaseClient } from './rpcClient'

// Same canonical, previously-verified address as basedex.ts — see that file's own header for the
// full provenance/verification disclosure.
export const BASE_UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'

// Same three standard, publicly-documented Uniswap V3 fee tiers basedex.ts already verified and
// uses for pricing (0.05% / 0.3% / 1%) — not re-derived, restated.
const UNISWAP_V3_FEE_TIERS = [500, 3000, 10000] as const

const UNISWAP_V3_FACTORY_ABI = [
  {
    type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

export type UniswapV3ValidationResult = { valid: boolean; fee: number | null }

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
          const capped: UniswapV3ValidationResult = { valid: false, fee: null }
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

// Real, on-chain implementation. NO RETRIES, DISCLOSED: each fee tier is tried exactly once; a
// failure on one tier just moves to the next real tier, never re-attempted.
export function createLiveUniswapV3PoolValidator(): UniswapV3PoolValidator {
  return {
    async validatePool(poolAddress, token0, token1) {
      const client = getSharedBaseClient()
      if (!client) return { valid: false, fee: null }
      for (const fee of UNISWAP_V3_FEE_TIERS) {
        try {
          const pool = await client.readContract({
            address: BASE_UNISWAP_V3_FACTORY as `0x${string}`,
            abi: UNISWAP_V3_FACTORY_ABI,
            functionName: 'getPool',
            args: [token0 as `0x${string}`, token1 as `0x${string}`, fee],
          })
          if (typeof pool === 'string' && pool.toLowerCase() === poolAddress.toLowerCase()) {
            return { valid: true, fee }
          }
        } catch {
          // Fails closed for this tier — tries the next real tier rather than throwing.
        }
      }
      return { valid: false, fee: null }
    },
  }
}
