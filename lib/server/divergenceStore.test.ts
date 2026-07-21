// Tests for lib/server/divergenceStore.ts. NOT wired into `npm test`. Run directly with:
//   npx tsx --test lib/server/divergenceStore.test.ts
//
// This sandbox has no Redis REST configuration, so the underlying redis.get/set fail open (no-op /
// null) — these tests verify the store's OWN logic (never throws, degrades gracefully) rather
// than real Redis persistence, which needs a real deployment to verify (same disclosed limitation
// as every other Redis-backed addition this session).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recordPricingDivergence, recordFifoDivergence, getDivergenceLog } from './divergenceStore'

describe('divergenceStore', () => {
  it('recordPricingDivergence never throws, even with no Redis configured', async () => {
    await assert.doesNotReject(() => recordPricingDivergence('0xabc', { price: 1 }, { price: 2 }, 'base'))
  })

  it('recordFifoDivergence never throws, even with no Redis configured', async () => {
    await assert.doesNotReject(() =>
      recordFifoDivergence(
        '0xabc',
        { realizedPnlUsd: 1, closedLots: 1 },
        { realizedPnlUsd: 2, closedLots: 1 },
        { realizedPnlUsd: 3, unrealizedPnlUsd: 0 },
      ),
    )
  })

  it('getDivergenceLog never throws and returns an array even with no Redis configured', async () => {
    const log = await getDivergenceLog()
    assert.ok(Array.isArray(log))
  })
})
