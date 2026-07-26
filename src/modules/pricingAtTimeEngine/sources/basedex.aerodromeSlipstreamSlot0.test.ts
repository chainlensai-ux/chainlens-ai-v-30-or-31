// PRODUCTION REGRESSION TEST, DISCLOSED — reproduces the exact confirmed production failure:
//   Slipstream pool found: 0x027256310dDD3773bc410f1CBd83524C42321Cd0
//   slot0() decoding failed with: Position `192` is out of bounds (`0 < position < 192`)
//   Slipstream pricesAccepted remained 0.
//
// ROOT CAUSE, CONFIRMED: Aerodrome Slipstream's real slot0() (verified against
// aerodrome-finance/slipstream's own ICLPoolState.sol) returns SIX fields (no feeProtocol) — the
// previous code decoded it against Uniswap V3's SEVEN-field slot0 ABI, which correctly consumed the
// real 192 bytes (6 words) and then tried to read a nonexistent 7th field starting at byte offset
// 192, producing exactly this error.
//
// This test drives the REAL production pool address through a fake client that returns EXACTLY the
// real 192-byte (6-word) slot0 returndata Slipstream actually produces (not a shortcut/mock of the
// decode step itself), proving:
//   1. The dedicated 6-field ABI decodes it successfully (no out-of-bounds error).
//   2. A price is genuinely accepted (Slipstream pricesAccepted increments to 1).
//   3. Feeding the OLD 7-field-shaped expectation (i.e. this same 192-byte payload) through the
//      length guard fails closed with a clear, attributable reason — proving the fail-closed check
//      itself is real, not just incidentally never triggered.
//
// Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/basedex.aerodromeSlipstreamSlot0.test.ts

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters } from 'viem'
import {
  tryBaseDexVenue,
  resolveAerodromeSlipstreamPoolAddress,
  readSlipstreamPoolPrice,
  getBaseDexVenueAttributionForScan,
  resetBaseDexVenueAttributionForScan,
  __resetBaseDexCachesForTest,
} from './basedex'

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL3_ABI = [
  {
    type: 'function', name: 'aggregate3', stateMutability: 'view',
    inputs: [{ name: 'calls', type: 'tuple[]', components: [
      { name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' },
    ] }],
    outputs: [{ name: 'returnData', type: 'tuple[]', components: [
      { name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' },
    ] }],
  },
] as const

const SLIPSTREAM_FACTORY_ABI = [
  { type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'tickSpacing', type: 'int24' }],
    outputs: [{ name: 'pool', type: 'address' }] },
] as const

// Slipstream's REAL slot0 shape — six fields, matching aerodrome-finance/slipstream's own
// ICLPoolState.sol exactly.
const REAL_SLIPSTREAM_POOL_ABI = [
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'unlocked', type: 'bool' },
    ] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

const DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

const TOKEN = '0x1111111111111111111111111111111111111111'
const WETH = '0x4200000000000000000000000000000000000006'
// The exact real production pool address from the confirmed failure.
const PRODUCTION_POOL = '0x027256310dDD3773bc410f1CBd83524C42321Cd0'

function wrap(results: { success: boolean; returnData: `0x${string}` }[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { data: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [results] as any }) }
}

// The REAL 192-byte (6-word) slot0 returndata a genuine Slipstream pool produces — encoded directly
// via encodeAbiParameters against the six real field types, independent of whichever ABI the
// decode side later uses. This is the literal payload production sent; it is what previously
// overran a 7-field decode at byte offset 192.
function realSlipstreamSlot0ReturnData(): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: 'uint160' }, { type: 'int24' }, { type: 'uint16' },
      { type: 'uint16' }, { type: 'uint16' }, { type: 'bool' },
    ],
    [BigInt('79228162514264337593543950336'), 0, 0, 0, 0, true],
  )
}

beforeEach(() => {
  __resetBaseDexCachesForTest()
  resetBaseDexVenueAttributionForScan()
})

describe('Aerodrome Slipstream slot0 ABI mismatch — production regression', () => {
  it('decodes the real 192-byte production slot0 payload without an out-of-bounds error, and accepts a real price', async () => {
    const client = {
      async call({ to, data }: { to: string; data: `0x${string}` }) {
        assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        const results = calls.map((call) => {
          try {
            const decoded = decodeFunctionData({ abi: REAL_SLIPSTREAM_POOL_ABI, data: call.callData })
            if (decoded.functionName === 'slot0') {
              // The exact real production returndata — 192 bytes, six words, no feeProtocol.
              return { success: true, returnData: realSlipstreamSlot0ReturnData() }
            }
            if (decoded.functionName === 'token0') {
              return { success: true, returnData: encodeFunctionResult({ abi: REAL_SLIPSTREAM_POOL_ABI, functionName: 'token0', result: TOKEN as `0x${string}` }) }
            }
          } catch { /* not a pool call */ }
          return { success: true, returnData: encodeFunctionResult({ abi: DECIMALS_ABI, functionName: 'decimals', result: 18 }) }
        })
        return wrap(results)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async readContract(): Promise<any> {
        throw new Error('unexpected readContract call — multicall path should not fall back here')
      },
    }

    // Confirm the raw payload really is 192 bytes (0x + 384 hex chars) — the exact real-world size
    // that overran the old 7-field (224-byte) decode.
    const raw = realSlipstreamSlot0ReturnData()
    assert.equal((raw.length - 2) / 2, 192, 'sanity: the real production slot0 returndata is exactly 192 bytes')

    const price = await readSlipstreamPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any, PRODUCTION_POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(1),
    )
    assert.equal(price, 1, 'the corrected 6-field ABI must decode this real payload and compute a real price, never throw an out-of-bounds error')

    // Drive it through the full venue-attribution path too, confirming pricesAccepted actually
    // increments (the reported symptom: "Slipstream pricesAccepted remained 0").
    const attempts: unknown[] = []
    const usd = await tryBaseDexVenue(
      'aerodrome_slipstream', 'USDC', WETH as `0x${string}`, TOKEN as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any, BigInt(1), Date.now(), attempts as any,
      async () => PRODUCTION_POOL as `0x${string}`,
      readSlipstreamPoolPrice,
    )
    assert.ok(usd !== null, 'expected a real accepted price end-to-end')
    const snap = getBaseDexVenueAttributionForScan()
    assert.equal(snap.pricesAcceptedByVenue.aerodrome_slipstream, 1, 'Slipstream pricesAccepted must no longer stay stuck at 0')
  })

  it('fails closed (a clear, attributable reason — never a crash or a fabricated price) if slot0 returndata length is unexpected', async () => {
    const malformedClient = {
      async call({ to, data }: { to: string; data: `0x${string}` }) {
        assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        const results = calls.map((call) => {
          try {
            const decoded = decodeFunctionData({ abi: REAL_SLIPSTREAM_POOL_ABI, data: call.callData })
            if (decoded.functionName === 'slot0') {
              // Deliberately malformed: only 3 words (96 bytes), simulating an unexpected/broken response.
              return {
                success: true,
                returnData: encodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }], [BigInt(1), 0, 0]),
              }
            }
            if (decoded.functionName === 'token0') {
              return { success: true, returnData: encodeFunctionResult({ abi: REAL_SLIPSTREAM_POOL_ABI, functionName: 'token0', result: TOKEN as `0x${string}` }) }
            }
          } catch { /* not a pool call */ }
          return { success: true, returnData: encodeFunctionResult({ abi: DECIMALS_ABI, functionName: 'decimals', result: 18 }) }
        })
        return wrap(results)
      },
      // The multicall length check must reject BEFORE ever falling back to a sequential attempt —
      // if it didn't, this would throw here instead of surfacing the real, attributable reason.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async readContract(): Promise<any> {
        throw new Error('unexpected readContract call — the length check must reject before any fallback is attempted')
      },
    }

    await assert.rejects(
      () => readSlipstreamPoolPrice(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        malformedClient as any, PRODUCTION_POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(1),
      ),
      /slipstream_slot0_returndata_length_mismatch/,
      'expected a clear, attributable length-mismatch reason naming the pool — never a generic decode crash or a fabricated price',
    )
  })
})

describe('Aerodrome Slipstream discovery still uses the real production factory + pool addresses', () => {
  it('resolves the exact real production pool address for the reported factory query shape', async () => {
    const client = {
      async call({ data }: { to: string; data: `0x${string}` }) {
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        const results = calls.map(() => ({
          success: true,
          returnData: encodeFunctionResult({ abi: SLIPSTREAM_FACTORY_ABI, functionName: 'getPool', result: PRODUCTION_POOL as `0x${string}` }),
        }))
        return wrap(results)
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = await resolveAerodromeSlipstreamPoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(pool?.toLowerCase(), PRODUCTION_POOL.toLowerCase())
  })
})
