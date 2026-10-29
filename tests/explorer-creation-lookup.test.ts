// Deployer creation lookups: Base goes through Etherscan V2 (chainid 8453), never the retired api.basescan.org V1
// host whose "deprecated endpoint" reply was read as "no creation record", and a status "0" miss is classified.
//   npx tsx --test tests/explorer-creation-lookup.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyCreationLookupMiss, creationLookupApiKey, creationLookupUrl } from '../lib/server/explorerCreationLookup.ts'

test('Base creation lookup is an Etherscan V2 URL with chainid 8453', () => {
  const url = new URL(creationLookupUrl('base', '0x940181a94a35a4569e4529a3cdfb74e38fd98631', 'k'))
  assert.equal(url.origin + url.pathname, 'https://api.etherscan.io/v2/api')
  assert.equal(url.searchParams.get('chainid'), '8453')
  assert.equal(url.searchParams.get('action'), 'getcontractcreation')
  assert.equal(new URL(creationLookupUrl('eth', '0x1', 'k')).searchParams.get('chainid'), '1')
  assert.equal(new URL(creationLookupUrl('bnb', '0x1', 'k')).searchParams.get('chainid'), '56')
})

test('V2 prefers the Etherscan key for Base and falls back to a Basescan key', () => {
  const saved = { e: process.env.ETHERSCAN_API_KEY, b: process.env.BASESCAN_API_KEY }
  try {
    process.env.ETHERSCAN_API_KEY = 'eth-key'; process.env.BASESCAN_API_KEY = 'base-key'
    assert.equal(creationLookupApiKey('base'), 'eth-key')
    delete process.env.ETHERSCAN_API_KEY
    assert.equal(creationLookupApiKey('base'), 'base-key')
    assert.equal(creationLookupApiKey('eth'), null)
  } finally {
    if (saved.e === undefined) delete process.env.ETHERSCAN_API_KEY; else process.env.ETHERSCAN_API_KEY = saved.e
    if (saved.b === undefined) delete process.env.BASESCAN_API_KEY; else process.env.BASESCAN_API_KEY = saved.b
  }
})

test('status "0" replies are classified without echoing the explorer text', () => {
  assert.equal(classifyCreationLookupMiss({ status: '0', message: 'NOTOK', result: 'You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration' }), 'deprecated_endpoint')
  assert.equal(classifyCreationLookupMiss({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }), 'invalid_api_key')
  assert.equal(classifyCreationLookupMiss({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }), 'rate_limited')
  assert.equal(classifyCreationLookupMiss({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.' }), 'plan_not_supported')
  assert.equal(classifyCreationLookupMiss({ status: '0', message: 'No data found', result: [] }), 'api_no_result')
})

test('no deployer creation lookup still calls the V1 Basescan host', () => {
  for (const f of ['../lib/server/deployerResolver.ts', '../app/api/token/route.ts', '../app/api/dev-wallet/route.ts', '../lib/server/devClusterDiagnosis.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /api\.basescan\.org\/api\?module=contract&action=getcontractcreation/, f)
  }
})
