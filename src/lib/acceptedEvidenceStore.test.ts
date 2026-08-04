import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAcceptedEvidenceKey, buildAcceptedEvidenceEnvelope, isValidAcceptedEvidence,
  readAcceptedEvidence, writeAcceptedEvidence, lotIdentityVersion, readAcceptedEvidenceBatch,
  ACCEPTED_EVIDENCE_SCHEMA_VERSION, type AcceptedEvidenceIdentity, type AcceptedEvidenceKvLike,
  type AcceptedEvidenceBatchIdentity,
} from './acceptedEvidenceStore'

function fakeKv(): AcceptedEvidenceKvLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

const IDENTITY: AcceptedEvidenceIdentity = { chain: 'base', token: '0xTOKEN', txHash: '0xbuy', side: 'entry', timestamp: 1000, lotIdentityVersion: 'v1' }

describe('acceptedEvidenceStore', () => {
  it('a written envelope round-trips through read exactly', async () => {
    const kv = fakeKv()
    const envelope = buildAcceptedEvidenceEnvelope({ identity: IDENTITY, priceUsd: 3.5, valueUsd: 35, source: 'geckoterminal', evidenceType: 'chain-aware-historical', providerTimestampBucket: 990, now: 5000 })
    const written = await writeAcceptedEvidence(kv, envelope)
    assert.equal(written, true)
    const read = await readAcceptedEvidence(kv, IDENTITY, 5001)
    assert.deepEqual(read, envelope)
  })

  it('HARD ASSERTION: any identity mismatch (chain/token/txHash/side/timestamp/lotIdentityVersion) is a miss, never a coincidental reuse', async () => {
    const kv = fakeKv()
    const envelope = buildAcceptedEvidenceEnvelope({ identity: IDENTITY, priceUsd: 3.5, valueUsd: 35, source: 's', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: 5000 })
    await writeAcceptedEvidence(kv, envelope)
    assert.equal(await readAcceptedEvidence(kv, { ...IDENTITY, chain: 'eth' }, 5001), null)
    assert.equal(await readAcceptedEvidence(kv, { ...IDENTITY, token: '0xOTHER' }, 5001), null)
    assert.equal(await readAcceptedEvidence(kv, { ...IDENTITY, txHash: '0xother' }, 5001), null)
    assert.equal(await readAcceptedEvidence(kv, { ...IDENTITY, side: 'exit' }, 5001), null)
    assert.equal(await readAcceptedEvidence(kv, { ...IDENTITY, timestamp: 1001 }, 5001), null)
    assert.equal(await readAcceptedEvidence(kv, { ...IDENTITY, lotIdentityVersion: 'v2' }, 5001), null)
  })

  it('HARD ASSERTION: an expired entry is a miss, never used', async () => {
    const kv = fakeKv()
    const envelope = buildAcceptedEvidenceEnvelope({ identity: IDENTITY, priceUsd: 3.5, valueUsd: 35, source: 's', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: 0 })
    await writeAcceptedEvidence(kv, envelope)
    assert.equal(await readAcceptedEvidence(kv, IDENTITY, envelope.expiresAt + 1), null)
  })

  it('a schemaVersion bump invalidates old entries (requirement #4: explicit schemaVersion change)', async () => {
    const kv = fakeKv()
    const stale = { ...buildAcceptedEvidenceEnvelope({ identity: IDENTITY, priceUsd: 3.5, valueUsd: 35, source: 's', evidenceType: 't', providerTimestampBucket: null, now: 0 }), schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION - 1 }
    kv.store.set(buildAcceptedEvidenceKey(IDENTITY), stale)
    assert.equal(await readAcceptedEvidence(kv, IDENTITY, 100), null)
  })

  it('corrupted/malformed content is refused, never coerced', async () => {
    const kv = fakeKv()
    kv.store.set(buildAcceptedEvidenceKey(IDENTITY), { priceUsd: 'not-a-number' })
    assert.equal(await readAcceptedEvidence(kv, IDENTITY, 100), null)
    assert.equal(isValidAcceptedEvidence({ garbage: true }, IDENTITY, 100), false)
  })

  it('a KV read failure fails open — returns null, never throws', async () => {
    const kv: AcceptedEvidenceKvLike = { get: async () => { throw new Error('down') }, set: async () => 'OK' }
    const result = await readAcceptedEvidence(kv, IDENTITY, 100)
    assert.equal(result, null)
  })

  it('a KV write failure fails open — returns false, never throws', async () => {
    const kv: AcceptedEvidenceKvLike = { get: async () => null, set: async () => { throw new Error('down') } }
    const envelope = buildAcceptedEvidenceEnvelope({ identity: IDENTITY, priceUsd: 1, valueUsd: 1, source: 's', evidenceType: 't', providerTimestampBucket: null, now: 0 })
    const result = await writeAcceptedEvidence(kv, envelope)
    assert.equal(result, false)
  })

  it('lotIdentityVersion is order/case-consistent for the same lot identity', () => {
    const lot = { chain: 'base', token: '0xAbCd', openedTxHash: '0xbuy', closedTxHash: '0xsell', openedAt: 1, closedAt: 2, amount: 5 }
    const a = lotIdentityVersion(lot)
    const b = lotIdentityVersion({ ...lot, token: '0xabcd' })
    assert.equal(a, b, 'token case must not affect identity')
  })

  it('temporalDistanceMs is null exactly when providerTimestampBucket is null, and a real absolute diff otherwise', () => {
    const withBucket = buildAcceptedEvidenceEnvelope({ identity: IDENTITY, priceUsd: 1, valueUsd: 1, source: 's', evidenceType: 't', providerTimestampBucket: 900, now: 0 })
    assert.equal(withBucket.temporalDistanceMs, 100)
    const withoutBucket = buildAcceptedEvidenceEnvelope({ identity: IDENTITY, priceUsd: 1, valueUsd: 1, source: 's', evidenceType: 't', providerTimestampBucket: null, now: 0 })
    assert.equal(withoutBucket.temporalDistanceMs, null)
  })
})

describe('readAcceptedEvidenceBatch — bounded-concurrency batch reads (canonical-manifest-fast-path follow-up task, Part C)', () => {
  it('reads every distinct identity and reports the real key that resolved each one', async () => {
    const kv = fakeKv()
    const a: AcceptedEvidenceIdentity = { chain: 'base', token: '0xa', txHash: '0xbuya', side: 'entry', timestamp: 1, lotIdentityVersion: 'va' }
    const b: AcceptedEvidenceIdentity = { chain: 'base', token: '0xb', txHash: '0xbuyb', side: 'entry', timestamp: 1, lotIdentityVersion: 'vb' }
    await writeAcceptedEvidence(kv, buildAcceptedEvidenceEnvelope({ identity: a, priceUsd: 1, valueUsd: 1, source: 's', evidenceType: 't', providerTimestampBucket: null, now: 0 }))
    await writeAcceptedEvidence(kv, buildAcceptedEvidenceEnvelope({ identity: b, priceUsd: 2, valueUsd: 2, source: 's', evidenceType: 't', providerTimestampBucket: null, now: 0 }))

    const result = await readAcceptedEvidenceBatch(kv, [a, b], 0)
    assert.equal(result.byKey.get(buildAcceptedEvidenceKey(a))?.priceUsd, 1)
    assert.equal(result.byKey.get(buildAcceptedEvidenceKey(b))?.priceUsd, 2)
    assert.equal(result.uniqueKeysRead, 2)
  })

  it('HARD ASSERTION: deduplicates identical identities into ONE real read, never one per duplicate', async () => {
    const kv = fakeKv()
    let reads = 0
    const countingKv: AcceptedEvidenceKvLike = { get: async (key) => { reads += 1; return kv.get(key) }, set: kv.set }
    const identity: AcceptedEvidenceIdentity = { chain: 'base', token: '0xa', txHash: '0xbuya', side: 'entry', timestamp: 1, lotIdentityVersion: 'va' }
    await writeAcceptedEvidence(kv, buildAcceptedEvidenceEnvelope({ identity, priceUsd: 5, valueUsd: 5, source: 's', evidenceType: 't', providerTimestampBucket: null, now: 0 }))

    const requests: AcceptedEvidenceBatchIdentity[] = Array.from({ length: 10 }, () => ({ ...identity }))
    const result = await readAcceptedEvidenceBatch(countingKv, requests, 0)
    assert.equal(reads, 1, 'ten identical requests must issue exactly one real KV read')
    assert.equal(result.keysRequested, 10)
    assert.equal(result.uniqueKeysRead, 1)
  })

  it('a `anyLotVersion: true` entry dispatches to the relaxed discovery read', async () => {
    const kv = fakeKv()
    const written: AcceptedEvidenceIdentity = { chain: 'base', token: '0xa', txHash: '0xbuya', side: 'entry', timestamp: 1, lotIdentityVersion: 'writer-version' }
    await writeAcceptedEvidence(kv, buildAcceptedEvidenceEnvelope({ identity: written, priceUsd: 9, valueUsd: 9, source: 's', evidenceType: 't', providerTimestampBucket: null, now: 0 }))

    const request: AcceptedEvidenceBatchIdentity = { chain: 'base', token: '0xa', txHash: '0xbuya', side: 'entry', timestamp: 1, anyLotVersion: true }
    const result = await readAcceptedEvidenceBatch(kv, [request], 0)
    const key = buildAcceptedEvidenceKey({ ...written })
    assert.equal(result.byKey.get(key)?.priceUsd, 9, 'a relaxed request must find the record regardless of which version wrote it')
  })

  it('a missing identity resolves to null in the map, never omitted and never thrown', async () => {
    const kv = fakeKv()
    const missing: AcceptedEvidenceIdentity = { chain: 'base', token: '0xnone', txHash: '0xnone', side: 'entry', timestamp: 1, lotIdentityVersion: 'v' }
    const result = await readAcceptedEvidenceBatch(kv, [missing], 0)
    assert.equal(result.byKey.has(buildAcceptedEvidenceKey(missing)), true)
    assert.equal(result.byKey.get(buildAcceptedEvidenceKey(missing)), null)
  })

  it('a KV read that throws fails open to null for that key, never blocking the rest of the batch', async () => {
    const kv = fakeKv()
    const good: AcceptedEvidenceIdentity = { chain: 'base', token: '0xgood', txHash: '0xgood', side: 'entry', timestamp: 1, lotIdentityVersion: 'v' }
    const bad: AcceptedEvidenceIdentity = { chain: 'base', token: '0xbad', txHash: '0xbad', side: 'entry', timestamp: 1, lotIdentityVersion: 'v' }
    await writeAcceptedEvidence(kv, buildAcceptedEvidenceEnvelope({ identity: good, priceUsd: 1, valueUsd: 1, source: 's', evidenceType: 't', providerTimestampBucket: null, now: 0 }))
    const flakyKv: AcceptedEvidenceKvLike = {
      get: async (key) => (key === buildAcceptedEvidenceKey(bad) ? Promise.reject(new Error('down')) : kv.get(key)),
      set: kv.set,
    }
    const result = await readAcceptedEvidenceBatch(flakyKv, [good, bad], 0)
    assert.equal(result.byKey.get(buildAcceptedEvidenceKey(good))?.priceUsd, 1)
    assert.equal(result.byKey.get(buildAcceptedEvidenceKey(bad)), null)
  })

  it('an empty request list returns an empty result without error', async () => {
    const result = await readAcceptedEvidenceBatch(fakeKv(), [], 0)
    assert.equal(result.byKey.size, 0)
    assert.equal(result.keysRequested, 0)
  })
})
