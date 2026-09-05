// Tests for shared GoldRush page attribution (src/modules/recoveryPolicy/index.ts).
// Run with: npx tsx --test src/modules/recoveryPolicy/sharedPageAttribution.test.ts
//
// Confirmed live defect: 8 recovery tokens triggered, page cap 6 funded only 3 dedicated
// fetches, and the other 5 were dropped AFTER the per-chain GoldRush page was already paid.
// These assert the 12-token eligibility cap, lots-completable ranking, and that a successful
// shared-page match cannot be overwritten by a later empty dedicated result.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ELIGIBLE_RECOVERY_TOKENS,
  attributeSharedGoldrushEvents,
  mergeRawProviderEvents,
  planRecoveryFetches,
  selectEligibleRecoveryTokens,
  type CandidateEvaluation,
} from './index'
import type { RecoveryPolicyCaps } from './types'
import type { RawProviderEvent } from '../providerFetchWindow/types'

function candidate(token: string, sellCount = 1, recoveryTriggered = true): CandidateEvaluation {
  return {
    token,
    chain: 'base',
    triggeredBy: recoveryTriggered ? [{ rule: 'token_value_usd_gte', evidenceSource: 'buyTimeline', evidenceEntryRefs: [], detail: '' }] : [],
    recoveryTriggered,
    coverageMateriality: { sellCount, cumulativeBuyUsd: sellCount * 100 },
  }
}

function event(contract: string, txHash = '0x1'): RawProviderEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash, timestamp: '2024-01-01T00:00:00Z',
    fromAddress: '0xdead', toAddress: '0xwallet', contract, symbol: 'T', amountRaw: '1', tokenDecimals: 18,
  }
}

const CAPS: RecoveryPolicyCaps = { maxHistoricalPagesPerWallet: 6, maxHistoricalPagesPerToken: 4 }

describe('selectEligibleRecoveryTokens — 12-token lots-completable ranking', () => {
  it('caps eligibility at 12 and keeps the highest-sell tokens', () => {
    const candidates = Array.from({ length: 15 }, (_, i) => candidate(`0x${i.toString(16).padStart(40, '0')}`, i + 1))
    const eligible = selectEligibleRecoveryTokens(candidates)
    assert.equal(eligible.size, MAX_ELIGIBLE_RECOVERY_TOKENS)
    assert.equal(MAX_ELIGIBLE_RECOVERY_TOKENS, 12)
    assert.ok(eligible.has('base:0x000000000000000000000000000000000000000e'), 'the 14-sell token (index 14) must be eligible')
    assert.equal(eligible.has('base:0x0000000000000000000000000000000000000000'), false, 'the 1-sell token (index 0) is outside the 12-cap')
  })

  it('does not spend pages — planRecoveryFetches still funds only 3 dedicated candidates', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => candidate(`t${i}`, 8 - i))
    const eligible = selectEligibleRecoveryTokens(candidates)
    const plan = planRecoveryFetches(candidates, CAPS)
    assert.equal(eligible.size, 8, 'all 8 triggered tokens fit under the 12-cap')
    assert.equal(plan.filter((p) => p.pageBudget > 0).length, 3, 'dedicated page budget is unchanged')
  })
})

describe('attributeSharedGoldrushEvents — paid shared page services every eligible token', () => {
  const shared = [
    event('0xaaa'),
    event('0xbbb'),
    event('0xccc'),
    event('0xddd'),
    event('0xeee'),
  ]

  it('THE LIVE BUG: a ranked-eligible token with zero dedicated budget still receives matches from the paid shared page', () => {
    const result = attributeSharedGoldrushEvents({
      token: '0xddd',
      chain: 'base',
      dedicatedEvents: [],
      sharedEvents: shared,
      rankedEligible: true,
      chainWasFetched: true,
    })
    assert.equal(result.includedInSharedRequest, true)
    assert.equal(result.matchingFromShared, 1)
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0].contract, '0xddd')
  })

  it('a successful shared match is not overwritten by a later empty dedicated result', () => {
    const sharedHit = attributeSharedGoldrushEvents({
      token: '0xaaa',
      chain: 'base',
      dedicatedEvents: [],
      sharedEvents: shared,
      rankedEligible: true,
      chainWasFetched: true,
    })
    const afterEmptyDedicated = mergeRawProviderEvents(sharedHit.events, [])
    assert.equal(afterEmptyDedicated.length, 1, 'empty dedicated events must not wipe the shared match')
    assert.equal(afterEmptyDedicated[0].contract, '0xaaa')
  })

  it('an unranked token is not attributed even if the shared page contains it', () => {
    const result = attributeSharedGoldrushEvents({
      token: '0xeee',
      chain: 'base',
      dedicatedEvents: [],
      sharedEvents: shared,
      rankedEligible: false,
      chainWasFetched: true,
    })
    assert.equal(result.includedInSharedRequest, false)
    assert.equal(result.events.length, 0)
  })

  it('a ranked token on a chain that was never paid is not attributed (page budget unchanged)', () => {
    const result = attributeSharedGoldrushEvents({
      token: '0xaaa',
      chain: 'eth',
      dedicatedEvents: [],
      sharedEvents: shared,
      rankedEligible: true,
      chainWasFetched: false,
    })
    assert.equal(result.includedInSharedRequest, false)
    assert.equal(result.events.length, 0)
  })

  it('dedicated Alchemy events are preserved when GoldRush matches are merged', () => {
    const alchemy: RawProviderEvent = {
      provider: 'alchemy', chain: 'base', txHash: '0xa1', timestamp: '2024-01-01T00:00:00Z',
      fromAddress: '0xdead', toAddress: '0xwallet', contract: '0xaaa', symbol: 'T', amountRaw: '2', tokenDecimals: 18,
    }
    const result = attributeSharedGoldrushEvents({
      token: '0xaaa',
      chain: 'base',
      dedicatedEvents: [alchemy],
      sharedEvents: shared,
      rankedEligible: true,
      chainWasFetched: true,
    })
    assert.equal(result.events.length, 2)
    assert.ok(result.events.some((e) => e.provider === 'alchemy'))
    assert.ok(result.events.some((e) => e.provider === 'goldrush'))
  })
})
