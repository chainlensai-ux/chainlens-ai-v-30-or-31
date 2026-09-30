// lib/server/multicall3.ts — the canonical Multicall3 aggregate3 encoding for raw JSON-RPC callers.
// SOURCE, DISCLOSED: the address and ABI are the ones already verified and used in production by
// src/modules/pricingAtTimeEngine/sources/basedex.ts (MULTICALL3_ADDRESS / MULTICALL3_ABI — Base
// Multicall3, a CREATE2 deployment at the same address on virtually every EVM chain). They are
// mirrored here rather than imported so lib/server callers don't pull the pricing engine into their
// bundle; tests/v4-base-position-ownership.test.ts asserts the two stay identical.
// aggregate3 with allowFailure: true per sub-call — one reverting sub-call never fails the batch;
// each result carries its own success flag and return bytes and must be decoded independently.

import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

export const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'view',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

export type Multicall3SubCall = { target: string; callData: string }
export type Multicall3SubResult = { success: boolean; returnData: string }

/** aggregate3 calldata; every sub-call has allowFailure: true. */
export function encodeAggregate3(calls: ReadonlyArray<Multicall3SubCall>): string {
  return encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [calls.map((c) => ({ target: c.target as Hex, allowFailure: true, callData: c.callData as Hex }))],
  })
}

/** Decodes an aggregate3 return; null when malformed or when the result count does not match. */
export function decodeAggregate3(raw: unknown, expected: number): Multicall3SubResult[] | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw) || raw.length < 2 + 128) return null
  try {
    const out = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data: raw as Hex }) as unknown as Array<{ success: boolean; returnData: string }>
    if (!Array.isArray(out) || out.length !== expected) return null
    return out.map((r) => ({ success: r.success === true, returnData: String(r.returnData ?? '0x') }))
  } catch {
    return null
  }
}
