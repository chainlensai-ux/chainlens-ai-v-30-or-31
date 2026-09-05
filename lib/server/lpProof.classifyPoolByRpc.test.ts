// LP SAFETY OPEN-CHECK FIX, DISCLOSED — Alchemy/RPC gap-fill tests for classifyPoolByRpc.
// token0()/token1()/totalSupply() were already being called (to decide the `probed` booleans)
// but the actual decoded values were discarded — lpSafetyResolutionAudit needs the real
// addresses/value, decoded here for free from the same eth_call responses (no extra RPC calls).
//
// Run directly with:
//   npx tsx --test lib/server/lpProof.classifyPoolByRpc.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPoolByRpc } from './lpProof'

const TOKEN0 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN1 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function padAddress(addr: string): string {
  return `0x${'0'.repeat(24)}${addr.replace(/^0x/, '')}`
}

let originalFetch: typeof fetch
let originalBaseRpcUrl: string | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalBaseRpcUrl = process.env.BASE_RPC_URL
  process.env.BASE_RPC_URL = 'https://example-test-rpc.invalid'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBaseRpcUrl === undefined) delete process.env.BASE_RPC_URL
  else process.env.BASE_RPC_URL = originalBaseRpcUrl
})

function stubRpc(bySelector: Record<string, string | null>) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const selector = String(body.params?.[0]?.data ?? '')
    const result = bySelector[selector] ?? null
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch
}

describe('classifyPoolByRpc — token0/token1/totalSupply decoding (Alchemy/RPC gap-fill)', () => {
  it('a real V2 pool decodes token0/token1 addresses and totalSupplyRaw — no extra RPC calls needed', async () => {
    stubRpc({
      '0x0dfe1681': padAddress(TOKEN0), // token0()
      '0xd21220a7': padAddress(TOKEN1), // token1()
      '0x0902f1ac': '0x' + '1'.repeat(64), // getReserves()
      '0x18160ddd': '0x' + (1_000_000).toString(16).padStart(64, '0'), // totalSupply()
    })
    const result = await classifyPoolByRpc('base', '0x1111111111111111111111111111111111111111')
    assert.equal(result.poolType, 'v2')
    assert.equal(result.hasLpToken, true)
    assert.equal(result.resolved.token0, TOKEN0)
    assert.equal(result.resolved.token1, TOKEN1)
    assert.equal(result.resolved.totalSupplyRaw, String(1_000_000))
  })

  it('a concentrated pool (slot0 present, no totalSupply) decodes token0/token1 but totalSupplyRaw stays null', async () => {
    stubRpc({
      '0x0dfe1681': padAddress(TOKEN0),
      '0xd21220a7': padAddress(TOKEN1),
      '0x3850c7bd': '0x' + '1'.repeat(64), // slot0()
    })
    const result = await classifyPoolByRpc('base', '0x2222222222222222222222222222222222222222')
    assert.equal(result.poolType, 'concentrated')
    assert.equal(result.hasLpToken, false)
    assert.equal(result.resolved.token0, TOKEN0)
    assert.equal(result.resolved.token1, TOKEN1)
    assert.equal(result.resolved.totalSupplyRaw, null)
  })

  it('an unresponsive/non-standard pool (every probe fails) reports poolType "unknown" with every value honestly null — never fabricated', async () => {
    stubRpc({})
    const result = await classifyPoolByRpc('base', '0x3333333333333333333333333333333333333333')
    assert.equal(result.poolType, 'unknown')
    assert.equal(result.hasLpToken, null)
    assert.equal(result.resolved.token0, null)
    assert.equal(result.resolved.token1, null)
    assert.equal(result.resolved.totalSupplyRaw, null)
  })

  it('an invalid pool address never attempts an RPC call at all', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    const result = await classifyPoolByRpc('base', 'not-an-address')
    assert.equal(called, false)
    assert.equal(result.poolType, 'unknown')
    assert.equal(result.resolved.token0, null)
  })
})
