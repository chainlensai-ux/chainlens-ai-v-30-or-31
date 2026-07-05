// Direct test for ChainSelectionView.tsx's selectChainActivity adapter. Uses node:test, same
// convention as the other module test files this session. NOT wired into `npm test` (which runs a
// single hardcoded file — see package.json). Run directly with:
//   npx tsx --test app/frontend/components/ChainSelectionView.selectChainActivity.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectChainActivity } from './ChainSelectionView'
import type { ChainSelectionResult } from '@/src/modules/chainSelection/types'
import type { ChainActivityRecord } from '@/lib/engine/modules/activity/types'

function chainSelection(overrides: Partial<ChainSelectionResult>): ChainSelectionResult {
  return { chains: [], activeChainCount: 0, dustChainCount: 0, ...overrides }
}
function activityRecord(overrides: Partial<ChainActivityRecord>): ChainActivityRecord {
  return {
    chainId: 1, lastActiveAt: null, activityLevel: 'medium', primaryUse: 'other',
    txCount30d: 5, valueHeldUsd: 100, valueMovedUsd30d: 0, ...overrides,
  }
}

describe('selectChainActivity', () => {
  it('equivalent V1/V2 inputs produce identical visible data (chainId, label, activityLevel, txCount30d)', () => {
    const v2 = selectChainActivity({
      chainActivityV2: [activityRecord({ chainId: 1, activityLevel: 'medium', txCount30d: 12 })],
    })
    // V1's "active_intelligence" maps to the same 'medium' middle-ground tier (see file header
    // disclosure — old data can't distinguish low/high, only active-vs-dust).
    const v1 = selectChainActivity({
      chainSelection: chainSelection({
        chains: [{ chain: 'eth', status: 'active_intelligence', visible_value_usd: 100, wallet_side_transactions: 12, swapCandidateEvents: 0, gates: { valueGate: true, activityGate: true, swapGate: false } }],
      }),
    })

    assert.equal(v1.chains[0].chainId, v2.chains[0].chainId) // both resolve eth -> 1
    assert.equal(v1.chains[0].activityLevel, v2.chains[0].activityLevel)
    assert.equal(v1.chains[0].txCount30d, v2.chains[0].txCount30d)
  })

  it('usingV2 flips correctly: true when chainActivityV2 is non-empty, false otherwise', () => {
    assert.equal(selectChainActivity({ chainActivityV2: [activityRecord({})] }).usingV2, true)
    assert.equal(selectChainActivity({ chainSelection: chainSelection({ chains: [{ chain: 'base', status: 'dust_low_signal', visible_value_usd: 0, wallet_side_transactions: 0, swapCandidateEvents: 0, gates: { valueGate: false, activityGate: false, swapGate: false } }] }) }).usingV2, false)
    assert.equal(selectChainActivity({}).usingV2, false)
  })

  it('chainActivityV2 takes priority over chainSelection when both are present', () => {
    const result = selectChainActivity({
      chainActivityV2: [activityRecord({ chainId: 8453, activityLevel: 'high', txCount30d: 99 })],
      chainSelection: chainSelection({ chains: [{ chain: 'eth', status: 'active_intelligence', visible_value_usd: 1, wallet_side_transactions: 1, swapCandidateEvents: 0, gates: { valueGate: true, activityGate: true, swapGate: false } }] }),
    })
    assert.equal(result.usingV2, true)
    assert.equal(result.chains.length, 1)
    assert.equal(result.chains[0].chainId, 8453)
  })

  it('empty cases degrade gracefully: no data, empty arrays -> chains: [], usingV2: false', () => {
    assert.deepEqual(selectChainActivity({}), { chains: [], usingV2: false })
    assert.deepEqual(selectChainActivity({ chainActivityV2: [], chainSelection: chainSelection({ chains: [] }) }), { chains: [], usingV2: false })
  })

  it('normalizes real V2 "dust-only" (hyphenated) to this component\'s own "dust" union member', () => {
    const result = selectChainActivity({ chainActivityV2: [activityRecord({ activityLevel: 'dust-only' })] })
    assert.equal(result.chains[0].activityLevel, 'dust')
  })
})
