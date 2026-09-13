// Regression tests for src/pipeline/diffEvidenceLoader.ts — the wallet-scanner speed audit's one
// implemented optimization.
//
// The bar this file has to clear is NOT "the new loader looks right" — it is "the new loader is
// INDISTINGUISHABLE from the sequential implementation it replaced." So every test below compares
// against `sequentialReference`, a verbatim re-implementation of the ORIGINAL inline loop from
// src/pipeline/index.ts (first-match `find` owner resolution, per-key await, `continue` on an
// unowned key, envelope -> {priceUsd, valueUsd, schemaVersion} | null). Equality is asserted on
// `[...map.entries()]`, which proves BOTH the entry set and the Map's own insertion order.
//
// Run directly with:
//   npx tsx --test src/pipeline/diffEvidenceLoader.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadDiffEvidenceByKey,
  buildDiffEvidenceOwnerIndex,
  DIFF_EVIDENCE_CONCURRENCY,
  type DiffEvidenceOwnerRecord,
  type DiffEvidenceSideTotals,
} from './diffEvidenceLoader'
import type { AcceptedEvidenceLoader } from '../lib/canonicalPnlSampleManifest'

type LoaderCall = { chain: string; token: string; txHash: string; side: 'entry' | 'exit'; timestamp: number; lotIdentityVersion: string | null }

function record(overrides: Partial<DiffEvidenceOwnerRecord> = {}): DiffEvidenceOwnerRecord {
  return {
    chain: 'base',
    token: '0xtoken',
    openedTxHash: '0xbuy',
    closedTxHash: '0xsell',
    openedAt: 1000,
    closedAt: 2000,
    entryEvidenceKey: 'k:entry',
    exitEvidenceKey: 'k:exit',
    ...overrides,
  }
}

// A loader that records every identity it was called with, and resolves an envelope from a fixture
// map keyed the same way the real accepted-evidence store keys are (chain:token:txHash:side:ts).
function trackingLoader(
  envelopes: Map<string, { priceUsd: number; valueUsd: number; schemaVersion: number } | null>,
  opts: { delayMs?: number; throwOn?: string } = {},
): { loader: AcceptedEvidenceLoader; calls: LoaderCall[]; maxInFlight: () => number } {
  const calls: LoaderCall[] = []
  let inFlight = 0
  let peak = 0
  const loader = (async (identity: LoaderCall) => {
    calls.push({ ...identity })
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
      const fixtureKey = `${identity.chain}:${identity.token}:${identity.txHash}:${identity.side}:${identity.timestamp}`
      if (opts.throwOn && fixtureKey === opts.throwOn) throw new Error('kv read failed')
      const hit = envelopes.get(fixtureKey)
      return hit ? ({ ...hit } as never) : null
    } finally {
      inFlight -= 1
    }
  }) as unknown as AcceptedEvidenceLoader
  return { loader, calls, maxInFlight: () => peak }
}

// VERBATIM re-implementation of the pre-optimization inline loop (src/pipeline/index.ts).
async function sequentialReference(
  keys: readonly string[],
  records: readonly DiffEvidenceOwnerRecord[],
  loadEvidence: AcceptedEvidenceLoader,
): Promise<Map<string, DiffEvidenceSideTotals | null>> {
  const out = new Map<string, DiffEvidenceSideTotals | null>()
  for (const key of keys) {
    const owner = records.find((r) => r.entryEvidenceKey === key || r.exitEvidenceKey === key)
    if (!owner) continue
    const side = owner.entryEvidenceKey === key ? 'entry' as const : 'exit' as const
    const envelope = await loadEvidence({
      chain: owner.chain, token: owner.token,
      txHash: side === 'entry' ? owner.openedTxHash : owner.closedTxHash,
      side, timestamp: side === 'entry' ? owner.openedAt : owner.closedAt,
      lotIdentityVersion: null,
    })
    out.set(key, envelope ? { priceUsd: envelope.priceUsd, valueUsd: envelope.valueUsd, schemaVersion: envelope.schemaVersion } : null)
  }
  return out
}

// A production-shaped fixture: 40 occurrence-group records across two "snapshots" (the real audit
// unions a freshly-rebuilt candidate manifest with the stored one), some sharing evidence keys, one
// key with no owning record at all, and several keys whose evidence is genuinely absent.
function productionShapedFixture() {
  const records: DiffEvidenceOwnerRecord[] = Array.from({ length: 40 }, (_, i) => record({
    token: `0xtok${i % 7}`,
    openedTxHash: `0xbuy${i}`,
    closedTxHash: `0xsell${i}`,
    openedAt: 1000 + i,
    closedAt: 2000 + i,
    entryEvidenceKey: `ev:entry:${i}`,
    exitEvidenceKey: `ev:exit:${i}`,
  }))
  // Second snapshot re-uses the first 20 keys (the common "nothing structurally changed" case) and
  // adds 5 of its own.
  const secondSnapshot: DiffEvidenceOwnerRecord[] = Array.from({ length: 5 }, (_, i) => record({
    token: `0xold${i}`,
    openedTxHash: `0xoldbuy${i}`,
    closedTxHash: `0xoldsell${i}`,
    openedAt: 500 + i,
    closedAt: 600 + i,
    entryEvidenceKey: `ev:old-entry:${i}`,
    exitEvidenceKey: `ev:old-exit:${i}`,
  }))
  const allRecords = [...records, ...secondSnapshot]
  const keys = [
    ...records.slice(0, 20).flatMap((r) => [r.entryEvidenceKey, r.exitEvidenceKey]),
    ...secondSnapshot.flatMap((r) => [r.entryEvidenceKey, r.exitEvidenceKey]),
    'ev:orphan-no-owning-record',
    ...records.slice(20).flatMap((r) => [r.entryEvidenceKey, r.exitEvidenceKey]),
  ]
  const envelopes = new Map<string, { priceUsd: number; valueUsd: number; schemaVersion: number } | null>()
  for (const [i, r] of allRecords.entries()) {
    // Every third record's entry side has genuinely no persisted evidence -> must record null.
    if (i % 3 !== 0) {
      envelopes.set(`${r.chain}:${r.token}:${r.openedTxHash}:entry:${r.openedAt}`, { priceUsd: 100 + i, valueUsd: 200 + i, schemaVersion: 2 })
    }
    envelopes.set(`${r.chain}:${r.token}:${r.closedTxHash}:exit:${r.closedAt}`, { priceUsd: 300 + i, valueUsd: 400 + i, schemaVersion: 2 })
  }
  return { allRecords, keys, envelopes }
}

describe('diffEvidenceLoader — behavior equivalence with the sequential original', () => {
  it('HARD ASSERTION: production-shaped fixture produces a Map identical entry-for-entry AND in identical insertion order', async () => {
    const { allRecords, keys, envelopes } = productionShapedFixture()

    const before = trackingLoader(envelopes)
    const expected = await sequentialReference(keys, allRecords, before.loader)

    const after = trackingLoader(envelopes)
    const actual = await loadDiffEvidenceByKey({ keys, records: allRecords, loadEvidence: after.loader })

    // Entry set AND insertion order.
    assert.deepEqual([...actual.entries()], [...expected.entries()])
    assert.equal(actual.size, expected.size)
    // The orphan key was skipped by both (never a fabricated null entry).
    assert.equal(actual.has('ev:orphan-no-owning-record'), false)
    // Genuinely-absent evidence is an explicit null, never an omitted key.
    assert.ok([...actual.values()].some((v) => v === null), 'fixture must genuinely exercise the absent-evidence path')
  })

  it('HARD ASSERTION (provider-call equivalence): the same reads, for the same identities, in the same multiset — never more calls than the sequential original', async () => {
    const { allRecords, keys, envelopes } = productionShapedFixture()

    const before = trackingLoader(envelopes)
    await sequentialReference(keys, allRecords, before.loader)

    const after = trackingLoader(envelopes)
    await loadDiffEvidenceByKey({ keys, records: allRecords, loadEvidence: after.loader })

    assert.equal(after.calls.length, before.calls.length, 'provider-call count must be identical, never higher')
    const canonical = (c: LoaderCall) => `${c.chain}:${c.token}:${c.txHash}:${c.side}:${c.timestamp}:${c.lotIdentityVersion}`
    assert.deepEqual([...after.calls].map(canonical).sort(), [...before.calls].map(canonical).sort())
  })

  it('first-match owner resolution is preserved when two records share an evidence key (entry side of the earlier record wins, exactly as Array.find did)', async () => {
    const shared = 'ev:shared'
    const first = record({ token: '0xfirst', openedTxHash: '0xfirstbuy', openedAt: 11, entryEvidenceKey: shared, exitEvidenceKey: 'ev:first-exit' })
    const second = record({ token: '0xsecond', closedTxHash: '0xsecondsell', closedAt: 22, entryEvidenceKey: 'ev:second-entry', exitEvidenceKey: shared })
    const records = [first, second]
    const keys = [shared]
    const envelopes = new Map([[`base:0xfirst:0xfirstbuy:entry:11`, { priceUsd: 1, valueUsd: 2, schemaVersion: 2 }]])

    const before = trackingLoader(envelopes)
    const expected = await sequentialReference(keys, records, before.loader)
    const after = trackingLoader(envelopes)
    const actual = await loadDiffEvidenceByKey({ keys, records, loadEvidence: after.loader })

    assert.deepEqual([...actual.entries()], [...expected.entries()])
    assert.deepEqual(after.calls, before.calls)
    assert.equal(after.calls[0].side, 'entry')
    assert.equal(after.calls[0].token, '0xfirst')
  })

  it('a record whose OWN entry and exit keys are identical resolves to the entry side, matching the original predicate\'s || short-circuit', async () => {
    const same = 'ev:same-both-sides'
    const records = [record({ entryEvidenceKey: same, exitEvidenceKey: same })]
    const index = buildDiffEvidenceOwnerIndex(records)
    assert.equal(index.get(same)?.side, 'entry')

    const envelopes = new Map([[`base:0xtoken:0xbuy:entry:1000`, { priceUsd: 9, valueUsd: 9, schemaVersion: 2 }]])
    const before = trackingLoader(envelopes)
    const expected = await sequentialReference([same], records, before.loader)
    const after = trackingLoader(envelopes)
    const actual = await loadDiffEvidenceByKey({ keys: [same], records, loadEvidence: after.loader })
    assert.deepEqual([...actual.entries()], [...expected.entries()])
  })

  it('empty keys and empty records are both no-ops that issue zero reads', async () => {
    const envelopes = new Map()
    const a = trackingLoader(envelopes)
    const noKeys = await loadDiffEvidenceByKey({ keys: [], records: [record()], loadEvidence: a.loader })
    assert.equal(noKeys.size, 0)
    assert.equal(a.calls.length, 0)

    const b = trackingLoader(envelopes)
    const noRecords = await loadDiffEvidenceByKey({ keys: ['ev:entry:0'], records: [], loadEvidence: b.loader })
    assert.equal(noRecords.size, 0)
    assert.equal(b.calls.length, 0)
  })

  it('a throwing loader still rejects, so the caller\'s own try/catch degrades the diagnostic exactly as before', async () => {
    const { allRecords, keys, envelopes } = productionShapedFixture()
    const owner = allRecords[1]
    const throwOn = `${owner.chain}:${owner.token}:${owner.closedTxHash}:exit:${owner.closedAt}`
    const { loader } = trackingLoader(envelopes, { throwOn })
    await assert.rejects(() => loadDiffEvidenceByKey({ keys, records: allRecords, loadEvidence: loader }))
  })
})

describe('diffEvidenceLoader — the actual speed property being bought', () => {
  it('HARD ASSERTION: reads run bounded-concurrently, never one-at-a-time — the sequential original is materially slower on the same fixture', async () => {
    const { allRecords, keys, envelopes } = productionShapedFixture()
    const DELAY_MS = 5

    const before = trackingLoader(envelopes, { delayMs: DELAY_MS })
    const seqStart = Date.now()
    await sequentialReference(keys, allRecords, before.loader)
    const sequentialMs = Date.now() - seqStart

    const after = trackingLoader(envelopes, { delayMs: DELAY_MS })
    const parStart = Date.now()
    await loadDiffEvidenceByKey({ keys, records: allRecords, loadEvidence: after.loader })
    const parallelMs = Date.now() - parStart

    assert.equal(before.maxInFlight(), 1, 'the original really was strictly serial')
    assert.ok(after.maxInFlight() > 1, 'the replacement must genuinely overlap reads')
    assert.ok(after.maxInFlight() <= DIFF_EVIDENCE_CONCURRENCY, 'but never unbounded — provider cost stays bounded')
    assert.ok(
      parallelMs < sequentialMs / 2,
      `bounded-concurrent load must be materially faster than strictly-serial (sequential ${sequentialMs}ms vs parallel ${parallelMs}ms)`,
    )
  })

  it('respects an explicitly lowered concurrency bound', async () => {
    const { allRecords, keys, envelopes } = productionShapedFixture()
    const { loader, maxInFlight } = trackingLoader(envelopes, { delayMs: 2 })
    await loadDiffEvidenceByKey({ keys, records: allRecords, loadEvidence: loader, concurrency: 2 })
    assert.ok(maxInFlight() <= 2)
  })
})
