import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAcceptedEvidenceKey, buildAcceptedEvidenceEnvelope, isValidAcceptedEvidence,
  readAcceptedEvidence, writeAcceptedEvidence, lotIdentityVersion,
  ACCEPTED_EVIDENCE_SCHEMA_VERSION, type AcceptedEvidenceIdentity, type AcceptedEvidenceKvLike,
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
