// PUMP INTERNAL SNAPSHOT TESTS, DISCLOSED (7d fallback fix): ChainLens-owned price snapshots must
// yield a real measured 7d change once enough history exists — and refuse to invent one when the
// window is too short or too stale.

import assert from 'node:assert/strict'
import { computeSnapshotChange7d, _resetSnapshotMemoryForTest, _seedSnapshotMemoryForTest } from '../lib/server/pump7dEvidence.ts'

_resetSnapshotMemoryForTest()

const DAY = 86_400_000
const now = Date.now()

// Not enough history → null change, honest refusal
{
  _seedSnapshotMemoryForTest([{
    chain: 'base', contract: '0xaaa', pair_address: null,
    price_usd: 0.001, liquidity_usd: 50_000, volume_24h_usd: 100_000,
    fdv_usd: 500_000, market_cap_usd: null, captured_at: new Date(now - 1 * DAY).toISOString(),
  }])
  const r = await computeSnapshotChange7d('base', '0xAAA', now)
  assert.equal(r.changePct, null, 'a single snapshot can never produce a change figure')
}

// Enough history (~6 days apart) → real measured change
{
  _resetSnapshotMemoryForTest()
  _seedSnapshotMemoryForTest([
    {
      chain: 'base', contract: '0xbbb', pair_address: '0xpair',
      price_usd: 0.001, liquidity_usd: 40_000, volume_24h_usd: 80_000,
      fdv_usd: 400_000, market_cap_usd: null, captured_at: new Date(now - 6 * DAY).toISOString(),
    },
    {
      chain: 'base', contract: '0xbbb', pair_address: '0xpair',
      price_usd: 0.0015, liquidity_usd: 60_000, volume_24h_usd: 120_000,
      fdv_usd: 600_000, market_cap_usd: null, captured_at: new Date(now - 0.2 * DAY).toISOString(),
    },
  ])
  const r = await computeSnapshotChange7d('base', '0xBBB', now)
  assert.ok(r.changePct != null, 'a ≥5-day snapshot span must produce a real measured change')
  assert.equal(Math.round(r.changePct), 50, 'change must be computed from real prices (0.001 → 0.0015 = +50%)')
}

// Too-short window (<5 days) → refuses to pass it off as a 7d figure
{
  _resetSnapshotMemoryForTest()
  _seedSnapshotMemoryForTest([
    {
      chain: 'eth', contract: '0xccc', pair_address: null,
      price_usd: 0.002, liquidity_usd: 30_000, volume_24h_usd: 60_000,
      fdv_usd: 300_000, market_cap_usd: null, captured_at: new Date(now - 1 * DAY).toISOString(),
    },
    {
      chain: 'eth', contract: '0xccc', pair_address: null,
      price_usd: 0.004, liquidity_usd: 35_000, volume_24h_usd: 70_000,
      fdv_usd: 350_000, market_cap_usd: null, captured_at: new Date(now - 0.1 * DAY).toISOString(),
    },
  ])
  const r = await computeSnapshotChange7d('eth', '0xCCC', now)
  assert.equal(r.changePct, null, 'a <5-day window is too short to call "7d" — refused')
}

console.log('test-pump-snapshots.mjs: all assertions passed')
