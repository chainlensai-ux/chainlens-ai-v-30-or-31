// Hosted check of the real CORTEX Memory writer against the ISOLATED Supabase test project only.
// Skipped unless BOTH are set, so a routine test run never touches the database even where the URL is configured:
//   CORTEX_MEMORY_TEST_SUPABASE_URL=https://wttoqlldbohidkkcmiws.supabase.co   (environment variable; not a secret)
//   CORTEX_MEMORY_RUN_HOSTED_TEST=1   (given on the command line for one deliberate run)
//
// The service-role key is NEVER in this process. Configure it as a Claude Code cloud "Network secret" for the host
// wttoqlldbohidkkcmiws.supabase.co: the agent proxy adds it to each request after the request leaves the VM.
// This test strips any apikey/Authorization headers from its own requests so the proxy-added key is the only one,
// and refuses to run if a key is present as an ordinary environment variable.
//
// Before any write it requires https://wttoqlldbohidkkcmiws.supabase.co, refuses the main ChainLens project and the
// app's own database, and reads scan_memory_daily — which only service_role may read — so a missing, wrong-role or
// other-project key stops the run before anything is written. Synthetic evidence only (token 0x…c0de…); no provider
// calls. Rows it writes are immutable to service_role by design; remove them afterwards with the owner-only statement
// printed at the end.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { RISK_INPUT_KEYS } from '../lib/server/scanMemory/canonical'
import { extractScanMemory, type ScanMemoryPayload } from '../lib/server/scanMemory/extract'
import { persistScanMemoryPayload, scheduleScanMemory } from '../lib/server/scanMemory/persist'
import { TOKEN_RISK_METHODOLOGY_VERSION } from '../lib/server/riskScore'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from '../lib/server/tokenPublicResponse'

const TEST_PROJECT = 'wttoqlldbohidkkcmiws'
const FORBIDDEN_PROJECT = 'tactylskqlzmgwdgyval'
const URL_ = process.env.CORTEX_MEMORY_TEST_SUPABASE_URL
const RUN_HOSTED = process.env.CORTEX_MEMORY_RUN_HOSTED_TEST === '1'
// Placeholder required by supabase-js; it is stripped from every request and never leaves the VM.
const PLACEHOLDER_KEY = 'injected-by-agent-proxy'

export function assertIsolatedTarget(url: string | undefined, env: Record<string, string | undefined> = process.env): void {
  assert.ok(url, 'CORTEX_MEMORY_TEST_SUPABASE_URL missing')
  assert.equal(env.CORTEX_MEMORY_TEST_SERVICE_ROLE_KEY, undefined,
    'a service-role key is set as a visible environment variable: remove it and use a Network secret instead')
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'https:', 'https only')
  assert.ok(!url.includes(FORBIDDEN_PROJECT), 'refusing the main ChainLens database')
  assert.equal(parsed.host, `${TEST_PROJECT}.supabase.co`, `target must be ${TEST_PROJECT}`)
  if (env.NEXT_PUBLIC_SUPABASE_URL) assert.notEqual(new URL(env.NEXT_PUBLIC_SUPABASE_URL).host, parsed.host, 'the test target must not be the app database')
}

/** fetch that removes credentials from outgoing requests, leaving the agent proxy's injected key as the only one. */
export const proxyCredentialFetch: typeof fetch = (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  headers.delete('apikey')
  headers.delete('authorization')
  return fetch(input instanceof Request ? input.url : input, { ...init, method: init?.method ?? (input instanceof Request ? input.method : undefined), headers })
}

// Synthetic token: fixed recognisable prefix + a per-run suffix, so reruns never collide and cleanup is exact.
const RUN = randomBytes(6).toString('hex')
const TOKEN = `0x00000000000000000000000000c0de${RUN}`.slice(0, 42)
const scan = (overrides: Record<string, unknown> = {}) => ({
  chain: 'base',
  contract: TOKEN,
  scanResponseSchemaVersion: TOKEN_SCAN_RESPONSE_SCHEMA_VERSION,
  riskMethodologyVersion: TOKEN_RISK_METHODOLOGY_VERSION,
  riskScore: 70,
  riskLabel: 'High Risk',
  scanRequestStartedAt: Date.now() - 1_000,
  priceUsd: 1.25,
  liquidityUsd: 10_000,
  marketCapUsd: 50_000,
  holderDistribution: { top10: 10.4, denominator: 'total_supply:rpc_total_supply' },
  contractFlags: { mint: { status: 'not_detected' }, blacklist: { status: 'not_detected' }, pause: { status: 'not_detected' } },
  lpControl: { status: 'locked' },
  devIntel: { deployerStatus: 'confirmed' },
  honeypot: { isHoneypot: false },
  riskInputStatuses: Object.fromEntries(RISK_INPUT_KEYS.map((key) => [key, 'verified'])),
  tokenScannerPipelineAudit: { firstFailureStage: null },
  ...overrides,
})

test('target guard refuses anything but the isolated project, and any visible key', () => {
  const ok = `https://${TEST_PROJECT}.supabase.co`
  const clean: Record<string, string | undefined> = {}
  assert.doesNotThrow(() => assertIsolatedTarget(ok, clean))
  assert.throws(() => assertIsolatedTarget(`https://${FORBIDDEN_PROJECT}.supabase.co`, clean))
  assert.throws(() => assertIsolatedTarget('https://other.supabase.co', clean))
  assert.throws(() => assertIsolatedTarget(`https://${TEST_PROJECT}.supabase.co.example.com`, clean), /target must be/)
  assert.throws(() => assertIsolatedTarget(`http://${TEST_PROJECT}.supabase.co`, clean), /https only/)
  assert.throws(() => assertIsolatedTarget(`${ok}/?x=${FORBIDDEN_PROJECT}`, clean), /main ChainLens/)
  assert.throws(() => assertIsolatedTarget(undefined, clean))
  assert.throws(() => assertIsolatedTarget(ok, { CORTEX_MEMORY_TEST_SERVICE_ROLE_KEY: 'x' }), /Network secret/)
  assert.throws(() => assertIsolatedTarget(ok, { NEXT_PUBLIC_SUPABASE_URL: ok }), /app database/)
})

test('requests carry no credential of their own', async () => {
  const realFetch = globalThis.fetch
  let seen: Headers | null = null
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => { seen = new Headers(init?.headers); return new Response('[]') }) as typeof fetch
  try {
    const client = createClient(`https://${TEST_PROJECT}.supabase.co`, PLACEHOLDER_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: proxyCredentialFetch } })
    await client.from('scan_memory_daily').select('day').limit(1)
    assert.ok(seen)
    assert.equal((seen as Headers).get('apikey'), null)
    assert.equal((seen as Headers).get('authorization'), null)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('real writer against the isolated Supabase project', { skip: !(URL_ && RUN_HOSTED) }, async (t) => {
  assertIsolatedTarget(URL_)
  const client = createClient(URL_!, PLACEHOLDER_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: proxyCredentialFetch } })
  // Read-only gate before anything is written: only service_role may read scan_memory_daily, and Supabase accepts a
  // key only on its own project — so success proves the injected key is this project's service-role key and the
  // migration is installed. On failure only the HTTP status and Supabase's message are printed, never headers.
  const probe = await client.from('scan_memory_daily').select('day').limit(1)
  assert.equal(probe.error, null, `scan_memory_daily not readable on ${TEST_PROJECT} (check the Network secret's host and apikey header): ${probe.status} ${probe.error?.message}`)
  console.info(JSON.stringify({ evt: 'scan_memory_hosted_test', project: TEST_PROJECT, token: TOKEN }))

  // Exactly the call the app makes (lib/server/scanMemory/persist.ts defaultRpc).
  const rpc = async (payload: ScanMemoryPayload) => {
    const { data, error } = await client.rpc('record_scan_memory', { p_payload: payload })
    if (error) throw new Error('scan_memory_rpc')
    return data as { outcome?: string; reason?: string } | null
  }
  const logs: string[] = []
  const info = console.info, error = console.error
  console.info = (l: string) => { logs.push(l) }
  console.error = (l: string) => { logs.push(l) }
  process.env.CORTEX_SCAN_MEMORY_ENABLED = 'true' // this test process only
  t.after(() => { console.info = info; console.error = error; delete process.env.CORTEX_SCAN_MEMORY_ENABLED })
  const lastLog = () => JSON.parse(logs.at(-1)!) as { outcome: string; reason?: string }
  const run = async (s: unknown) => {
    let work: (() => unknown) | null = null
    scheduleScanMemory(s, { after: (w) => { work = w }, rpc })
    assert.ok(work)
    const p = (work as () => unknown)()
    assert.ok(p instanceof Promise, 'after() receives the write promise')
    await p
  }
  const rows = async () => {
    const { data, error: e } = await client.from('scan_memory').select('evidence_hash, seen_count, risk_score').eq('token_address', TOKEN).order('inserted_at')
    assert.equal(e, null)
    return data as Array<{ evidence_hash: string; seen_count: number; risk_score: number }>
  }

  await t.test('insertion: accepted, stored hash equals the TypeScript hash', async () => {
    logs.length = 0
    await run(scan())
    assert.equal(lastLog().outcome, 'accepted')
    const extracted = extractScanMemory(scan())
    assert.ok(extracted.ok)
    assert.equal((await rows())[0]?.evidence_hash, extracted.payload.evidence_hash)
  })
  await t.test('deduplication: same evidence is one row seen twice', async () => {
    logs.length = 0
    await run(scan())
    assert.equal(lastLog().outcome, 'deduplicated')
    const r = await rows()
    assert.equal(r.length, 1)
    assert.equal(Number(r[0].seen_count), 2)
  })
  await t.test('changed evidence: a new row with a different hash', async () => {
    logs.length = 0
    await run(scan({ riskScore: 55, riskLabel: 'Caution' }))
    assert.equal(lastLog().outcome, 'accepted')
    const r = await rows()
    assert.equal(r.length, 2)
    assert.notEqual(r[0].evidence_hash, r[1].evidence_hash)
  })
  await t.test('tampered hash is rejected by the database', async () => {
    const e = extractScanMemory(scan({ riskScore: 40 }))
    assert.ok(e.ok)
    logs.length = 0
    await persistScanMemoryPayload({ ...e.payload, evidence_hash: 'f'.repeat(64) }, rpc)
    assert.deepEqual(lastLog(), { event: 'scan_memory', outcome: 'skipped', reason: 'invalid_signal' })
    assert.equal((await rows()).length, 2)
  })
  await t.test('error isolation: a database error and a hung call never throw', async () => {
    const e = extractScanMemory(scan({ riskScore: 41 }))
    assert.ok(e.ok)
    logs.length = 0
    // A real error response from this database (the function does not exist), with nothing written.
    await persistScanMemoryPayload(e.payload, async (p) => {
      const { data, error: err } = await client.rpc('record_scan_memory_does_not_exist', { p_payload: p })
      if (err) throw new Error('scan_memory_rpc')
      return data as { outcome?: string } | null
    })
    assert.deepEqual(lastLog(), { event: 'scan_memory', outcome: 'failed', reason: 'db_error' })
    logs.length = 0
    await persistScanMemoryPayload(e.payload, () => new Promise(() => undefined))
    assert.deepEqual(lastLog(), { event: 'scan_memory', outcome: 'failed', reason: 'db_timeout' })
    assert.equal((await rows()).length, 2, 'nothing written by failed calls')
  })
  await t.test('cleanup: service_role cannot delete evidence, purge keeps unexpired rows', async () => {
    const del = await client.from('scan_memory').delete().eq('token_address', TOKEN)
    assert.notEqual(del.error, null, 'service_role must not be able to delete')
    const { data, error: e } = await client.rpc('purge_expired_scan_memory', { p_limit: 1000 })
    assert.equal(e, null)
    assert.equal(typeof data, 'number')
    assert.equal((await rows()).length, 2, 'fresh synthetic rows are not purged')
    info(`Remove this run's synthetic rows in the ${TEST_PROJECT} SQL editor (owner role):\n` +
      `  delete from public.scan_memory where token_address = '${TOKEN}';`)
  })
})
