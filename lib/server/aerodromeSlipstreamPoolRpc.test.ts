// FINISH-CONCENTRATED-LP-OWNERSHIP-PROOF, DISCLOSED — tests for resolveAerodromeSlipstreamPoolRpc
// (Aerodrome Slipstream concentrated-LP position-owner resolution via the pool contract's own
// Mint/Burn event logs — no manager address needed at all, see that file's own header for the
// topic0 verification). Confirms: (1) it never attempts an RPC call outside its exact
// chain==='base' && poolModel==='slipstream' gate, (2) it correctly aggregates real Mint/Burn
// events into net-positive owners, (3) it never fabricates an owner when the RPC call fails.
//
// Run directly with:
//   npx tsx --test lib/server/aerodromeSlipstreamPoolRpc.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ConcentratedOwnerRecord } from './lpProof'

const POOL = '0x1234567890123456789012345678901234567890'
const OWNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OWNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const MINT_TOPIC0 = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
const BURN_TOPIC0 = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'

function padTopic(addr: string): string {
  return `0x${'0'.repeat(24)}${addr.replace(/^0x/, '')}`
}

// Mint data = sender(32B) + amount(32B) + amount0(32B) + amount1(32B)
function mintData(amount: bigint): string {
  const zero = '0'.repeat(64)
  const amt = amount.toString(16).padStart(64, '0')
  return `0x${zero}${amt}${zero}${zero}`
}

// Burn data = amount(32B) + amount0(32B) + amount1(32B)
function burnData(amount: bigint): string {
  const zero = '0'.repeat(64)
  const amt = amount.toString(16).padStart(64, '0')
  return `0x${amt}${zero}${zero}`
}

let originalFetch: typeof fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// RPC.base (lib/rpc.ts) is a module-level constant read from ALCHEMY_BASE_RPC_URL/
// ALCHEMY_BASE_KEY at import time — must be set BEFORE the module (and its transitive import of
// lib/rpc.ts) is ever loaded, so this uses a dynamic import (inside an async IIFE — top-level
// await isn't supported by this project's test transform) after setting the env var rather than a
// static top-of-file import.
void (async () => {
  process.env.ALCHEMY_BASE_RPC_URL = 'https://example-test-rpc.invalid'
  const { resolveAerodromeSlipstreamPoolRpc } = await import('./aerodromeSlipstreamPoolRpc')

  describe('resolveAerodromeSlipstreamPoolRpc — strict gating (never attempts RPC outside its exact case)', () => {
    it('returns null immediately for a non-base chain — never attempts a call', async () => {
      let called = false
      globalThis.fetch = (async () => { called = true; return { ok: true, json: async () => ({ result: [] }) } }) as unknown as typeof fetch
      const result = await resolveAerodromeSlipstreamPoolRpc({ chain: 'eth', poolModel: 'slipstream', poolAddress: POOL, poolId: null })
      assert.equal(result, null)
      assert.equal(called, false)
    })

    it('returns null immediately for a non-slipstream pool model on base — never attempts a call', async () => {
      let called = false
      globalThis.fetch = (async () => { called = true; return { ok: true, json: async () => ({ result: [] }) } }) as unknown as typeof fetch
      const result = await resolveAerodromeSlipstreamPoolRpc({ chain: 'base', poolModel: 'uniswap_v3', poolAddress: POOL, poolId: null })
      assert.equal(result, null)
      assert.equal(called, false)
    })

    it('returns null when no pool address is present, even on base+slipstream', async () => {
      const result = await resolveAerodromeSlipstreamPoolRpc({ chain: 'base', poolModel: 'slipstream', poolAddress: null, poolId: null })
      assert.equal(result, null)
    })
  })

  describe('resolveAerodromeSlipstreamPoolRpc — real event decoding (no fabricated ownership)', () => {
    it('aggregates a real Mint event into a resolvable net-positive owner', async () => {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const topic0 = body.params[0].topics[0]
        if (topic0 === MINT_TOPIC0) {
          return { ok: true, json: async () => ({ result: [{ topics: [MINT_TOPIC0, padTopic(OWNER_A), '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: mintData(BigInt(1000)) }] }) }
        }
        return { ok: true, json: async () => ({ result: [] }) }
      }) as unknown as typeof fetch
      const result = await resolveAerodromeSlipstreamPoolRpc({ chain: 'base', poolModel: 'slipstream', poolAddress: POOL, poolId: null }) as ConcentratedOwnerRecord[] | null
      assert.ok(Array.isArray(result))
      assert.equal(result!.length, 1)
      assert.equal(result![0].address, OWNER_A)
      assert.equal(result![0].liquidityRaw, '1000')
    })

    it('nets Mint and Burn for the same owner — a fully withdrawn position is never reported as a real owner', async () => {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const topic0 = body.params[0].topics[0]
        if (topic0 === MINT_TOPIC0) {
          return { ok: true, json: async () => ({ result: [{ topics: [MINT_TOPIC0, padTopic(OWNER_A), '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: mintData(BigInt(500)) }] }) }
        }
        if (topic0 === BURN_TOPIC0) {
          return { ok: true, json: async () => ({ result: [{ topics: [BURN_TOPIC0, padTopic(OWNER_A), '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: burnData(BigInt(500)) }] }) }
        }
        return { ok: true, json: async () => ({ result: [] }) }
      }) as unknown as typeof fetch
      const result = await resolveAerodromeSlipstreamPoolRpc({ chain: 'base', poolModel: 'slipstream', poolAddress: POOL, poolId: null }) as ConcentratedOwnerRecord[] | null
      assert.ok(Array.isArray(result))
      assert.equal(result!.length, 0, 'a fully net-zero owner must never appear as a resolved position owner')
    })

    it('keeps the larger of two owners ranked first by net liquidity', async () => {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const topic0 = body.params[0].topics[0]
        if (topic0 === MINT_TOPIC0) {
          return {
            ok: true,
            json: async () => ({
              result: [
                { topics: [MINT_TOPIC0, padTopic(OWNER_A), '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: mintData(BigInt(100)) },
                { topics: [MINT_TOPIC0, padTopic(OWNER_B), '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: mintData(BigInt(900)) },
              ],
            }),
          }
        }
        return { ok: true, json: async () => ({ result: [] }) }
      }) as unknown as typeof fetch
      const result = await resolveAerodromeSlipstreamPoolRpc({ chain: 'base', poolModel: 'slipstream', poolAddress: POOL, poolId: null }) as ConcentratedOwnerRecord[] | null
      assert.equal(result!.length, 2)
      assert.equal(result![0].address, OWNER_B, 'the larger net liquidity owner must be ranked first')
    })

    it('returns null (never a fabricated empty-but-confident result) when the RPC call fails', async () => {
      globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => null })) as unknown as typeof fetch
      const result = await resolveAerodromeSlipstreamPoolRpc({ chain: 'base', poolModel: 'slipstream', poolAddress: POOL, poolId: null }) as ConcentratedOwnerRecord[] | null
      assert.equal(result, null)
    })

    it('returns an empty array (a real, honest "no positions found") when both queries succeed with zero logs', async () => {
      globalThis.fetch = (async () => ({ ok: true, json: async () => ({ result: [] }) })) as unknown as typeof fetch
      const result = await resolveAerodromeSlipstreamPoolRpc({ chain: 'base', poolModel: 'slipstream', poolAddress: POOL, poolId: null }) as ConcentratedOwnerRecord[] | null
      assert.deepEqual(result, [])
    })
  })
})()
