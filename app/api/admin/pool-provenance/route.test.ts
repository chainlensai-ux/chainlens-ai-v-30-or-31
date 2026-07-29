// Tests for the admin pool-provenance route — validation logic (pure, no I/O) plus the
// auth-gate/JSON-shape/no-store contract for GET and unauthenticated POST, which don't require any
// Supabase/BaseScan/RPC env configuration to exercise safely.
//
// NOT wired into `npm test` by directory convention (matches
// app/api/scan-v2/full-scan-job/start/route.jobKey.test.ts). Run directly with:
//   npx tsx --test app/api/admin/pool-provenance/route.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { validatePoolProvenanceRequestBody, GET, POST } from './route'

const VALID_BODY = {
  chain: 'base',
  pool: '0x7f31b371ac675bca3357fd9c26854fed067400c0',
  claimedFactory: '0xade65c38cd4849adba595a4323a8c7ddfe89716a',
  expectedToken0: '0x4200000000000000000000000000000000000006',
  expectedToken1: '0x5576d6ed9181f2225aff5282ac0ed29f755437ea',
  expectedFee: 10000,
}

test('validatePoolProvenanceRequestBody accepts the exact production-shaped request', () => {
  const result = validatePoolProvenanceRequestBody(VALID_BODY)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.pool, VALID_BODY.pool)
  assert.equal(result.value.chain, 'base')
})

test('validatePoolProvenanceRequestBody rejects a non-base chain', () => {
  const result = validatePoolProvenanceRequestBody({ ...VALID_BODY, chain: 'ethereum' })
  assert.equal(result.ok, false)
})

test('validatePoolProvenanceRequestBody rejects a malformed pool address', () => {
  const result = validatePoolProvenanceRequestBody({ ...VALID_BODY, pool: 'not-an-address' })
  assert.equal(result.ok, false)
})

test('validatePoolProvenanceRequestBody rejects a malformed claimedFactory address', () => {
  const result = validatePoolProvenanceRequestBody({ ...VALID_BODY, claimedFactory: '0x123' })
  assert.equal(result.ok, false)
})

test('validatePoolProvenanceRequestBody rejects missing expectedToken0/expectedToken1', () => {
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, expectedToken0: undefined }).ok, false)
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, expectedToken1: undefined }).ok, false)
})

test('validatePoolProvenanceRequestBody rejects a non-integer or negative expectedFee', () => {
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, expectedFee: 100.5 }).ok, false)
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, expectedFee: -1 }).ok, false)
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, expectedFee: '10000' }).ok, false)
})

test('validatePoolProvenanceRequestBody rejects a non-object body', () => {
  assert.equal(validatePoolProvenanceRequestBody(null).ok, false)
  assert.equal(validatePoolProvenanceRequestBody('string').ok, false)
  assert.equal(validatePoolProvenanceRequestBody(42).ok, false)
})

test('GET returns the exact required deployment-verification JSON shape, no auth required', async () => {
  const res = await GET()
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
  const body = await res.json()
  assert.deepEqual(body, { ok: true, route: 'pool-provenance' })
})

test('POST without an Authorization header is rejected as Unauthorized, JSON, no-store', async () => {
  const req = new NextRequest('http://localhost/api/admin/pool-provenance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  })
  const res = await POST(req)
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
  const body = await res.json()
  assert.deepEqual(body, { error: 'Unauthorized' })
})

test('POST with a garbage bearer token is rejected as Unauthorized (never falls through to the investigator)', async () => {
  const req = new NextRequest('http://localhost/api/admin/pool-provenance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
    body: JSON.stringify(VALID_BODY),
  })
  const res = await POST(req)
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.deepEqual(body, { error: 'Unauthorized' })
})
