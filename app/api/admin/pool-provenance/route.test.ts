// Tests for the admin pool-provenance route — validation logic (pure, no I/O), the hard-lock
// known-forensic-case match, and the kill-switch/JSON-shape/no-store contract for GET and POST.
//
// NOT wired into `npm test` by directory convention (matches
// app/api/scan-v2/full-scan-job/start/route.jobKey.test.ts). Run directly with:
//   npx tsx --test app/api/admin/pool-provenance/route.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'
import { validatePoolProvenanceRequestBody, matchesKnownForensicCase, KNOWN_FORENSIC_CASE } from '@/lib/server/poolProvenanceRequest'

const VALID_BODY = { ...KNOWN_FORENSIC_CASE }

const OTHER_ADDRESS_BODY = {
  chain: 'base' as const,
  pool: '0x1111111111111111111111111111111111111111',
  claimedFactory: '0x2222222222222222222222222222222222222222',
  expectedToken0: '0x4200000000000000000000000000000000000006',
  expectedToken1: '0x3333333333333333333333333333333333333333',
  expectedFee: 500,
}

function withEndpointEnabled<T>(fn: () => T): T {
  const original = process.env.POOL_PROVENANCE_ENDPOINT_ENABLED
  process.env.POOL_PROVENANCE_ENDPOINT_ENABLED = 'true'
  try {
    return fn()
  } finally {
    if (original === undefined) delete process.env.POOL_PROVENANCE_ENDPOINT_ENABLED
    else process.env.POOL_PROVENANCE_ENDPOINT_ENABLED = original
  }
}

function withEndpointDisabled<T>(fn: () => T): T {
  const original = process.env.POOL_PROVENANCE_ENDPOINT_ENABLED
  delete process.env.POOL_PROVENANCE_ENDPOINT_ENABLED
  try {
    return fn()
  } finally {
    if (original === undefined) delete process.env.POOL_PROVENANCE_ENDPOINT_ENABLED
    else process.env.POOL_PROVENANCE_ENDPOINT_ENABLED = original
  }
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/pool-provenance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ─── Validation (unchanged shape checks) ───────────────────────────────────────────────────────
test('validatePoolProvenanceRequestBody accepts the exact known forensic case', () => {
  const result = validatePoolProvenanceRequestBody(VALID_BODY)
  assert.equal(result.ok, true)
})

test('validatePoolProvenanceRequestBody rejects a non-base chain', () => {
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, chain: 'ethereum' }).ok, false)
})

test('validatePoolProvenanceRequestBody rejects a malformed pool address', () => {
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, pool: 'not-an-address' }).ok, false)
})

test('validatePoolProvenanceRequestBody rejects a non-integer or negative expectedFee', () => {
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, expectedFee: 100.5 }).ok, false)
  assert.equal(validatePoolProvenanceRequestBody({ ...VALID_BODY, expectedFee: -1 }).ok, false)
})

test('validatePoolProvenanceRequestBody rejects a non-object body', () => {
  assert.equal(validatePoolProvenanceRequestBody(null).ok, false)
})

// ─── Hard-lock match ────────────────────────────────────────────────────────────────────────────
test('matchesKnownForensicCase accepts the exact known case', () => {
  assert.equal(matchesKnownForensicCase(VALID_BODY), true)
})

test('matchesKnownForensicCase is case-insensitive on addresses only', () => {
  assert.equal(matchesKnownForensicCase({
    ...VALID_BODY,
    pool: VALID_BODY.pool.toUpperCase().replace('0X', '0x'),
    claimedFactory: VALID_BODY.claimedFactory.toUpperCase().replace('0X', '0x'),
  }), true)
})

test('matchesKnownForensicCase rejects any other pool address', () => {
  assert.equal(matchesKnownForensicCase({ ...VALID_BODY, pool: OTHER_ADDRESS_BODY.pool }), false)
})

test('matchesKnownForensicCase rejects any other claimedFactory', () => {
  assert.equal(matchesKnownForensicCase({ ...VALID_BODY, claimedFactory: OTHER_ADDRESS_BODY.claimedFactory }), false)
})

test('matchesKnownForensicCase rejects a different token pair', () => {
  assert.equal(matchesKnownForensicCase({ ...VALID_BODY, expectedToken1: OTHER_ADDRESS_BODY.expectedToken1 }), false)
})

test('matchesKnownForensicCase rejects a different fee, even with the correct addresses', () => {
  assert.equal(matchesKnownForensicCase({ ...VALID_BODY, expectedFee: 3000 }), false)
})

// ─── Kill switch ────────────────────────────────────────────────────────────────────────────────
test('GET returns 404 when the kill switch is off (default/unset)', async () => {
  await withEndpointDisabled(async () => {
    const res = await GET()
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
    const body = await res.json()
    assert.deepEqual(body, { error: 'Not found' })
  })
})

test('GET returns the deployment-verification JSON shape when the kill switch is on', async () => {
  await withEndpointEnabled(async () => {
    const res = await GET()
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
    const body = await res.json()
    assert.deepEqual(body, { ok: true, route: 'pool-provenance' })
  })
})

test('POST returns 404 when the kill switch is off, even for the exact known case, no token needed', async () => {
  await withEndpointDisabled(async () => {
    const res = await POST(postRequest(VALID_BODY))
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
    const body = await res.json()
    assert.deepEqual(body, { error: 'Not found' })
  })
})

// ─── No auth required, hard-locked to the known case ──────────────────────────────────────────────
test('POST with no Authorization header and the exact known case is accepted (no bearer token required)', async () => {
  await withEndpointEnabled(async () => {
    const res = await POST(postRequest(VALID_BODY))
    // No BASESCAN_API_KEY/ALCHEMY_BASE_RPC_URL configured in this sandbox -- the investigator
    // itself fails closed (provider_failure), but the important assertion is that it was reached
    // at all: never 401/403 for the exact known case with no token.
    assert.notEqual(res.status, 401)
    assert.notEqual(res.status, 403)
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
    const body = await res.json()
    assert.equal(body.ok, true)
  })
})

test('POST with any other valid-shaped address is rejected 403, never reaches the investigator', async () => {
  await withEndpointEnabled(async () => {
    const res = await POST(postRequest(OTHER_ADDRESS_BODY))
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
    const body = await res.json()
    assert.equal(body.ok, undefined)
    assert.ok(String(body.error).toLowerCase().includes('forbidden'))
  })
})

test('POST with the known pool but a different fee is rejected 403', async () => {
  await withEndpointEnabled(async () => {
    const res = await POST(postRequest({ ...VALID_BODY, expectedFee: 500 }))
    assert.equal(res.status, 403)
  })
})

test('POST still enforces existing shape validation before the hard-lock check', async () => {
  await withEndpointEnabled(async () => {
    const res = await POST(postRequest({ ...VALID_BODY, expectedFee: 'not-a-number' }))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'expectedFee must be a non-negative integer')
  })
})

test('POST with invalid JSON returns 400, still no-store JSON', async () => {
  await withEndpointEnabled(async () => {
    const req = new NextRequest('http://localhost/api/admin/pool-provenance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    })
    const res = await POST(req)
    assert.equal(res.status, 400)
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
  })
})
