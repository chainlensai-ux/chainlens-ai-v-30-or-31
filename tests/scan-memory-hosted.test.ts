// Hosted check of the real CORTEX Memory writer against the ISOLATED Supabase test project only.
// Skipped unless BOTH are set, so a routine test run never touches the database even where the URL is configured:
//   CORTEX_MEMORY_TEST_SUPABASE_URL=https://wttoqlldbohidkkcmiws.supabase.co   (environment variable; not a secret)
//   CORTEX_MEMORY_RUN_HOSTED_TEST=1   (given on the command line for one deliberate run)
//
// The service-role key is NEVER in this process. Configure it as a Claude Code cloud "Network secret" for the host
// wttoqlldbohidkkcmiws.supabase.co: the agent proxy replaces the dummy apikey header with it after the request leaves
// the VM. This test sends only that dummy apikey (and strips Authorization) so the proxy-supplied key is the only
// credential, and refuses to run if a key is present as an ordinary environment variable.
//
// Before any write it requires https://wttoqlldbohidkkcmiws.supabase.co, refuses the main ChainLens project and the
// app's own database, and reads scan_memory_daily — which only service_role may read — so a missing, wrong-role or
// other-project key stops the run before anything is written. It also refuses to write while synthetic rows from an
// earlier run remain. Synthetic evidence only (token 0x…c0de…); no provider calls. Calls cross the agent proxy, so the
// writer gets an injected test-only budget (production stays at SCAN_MEMORY_TIMEOUT_MS), and every database call is
// awaited before rows are counted or cleanup is reported, so no late write follows the check. Rows it writes are
// immutable to service_role by design; remove them afterwards with the owner-only statement printed at the end.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { RISK_INPUT_KEYS } from '../lib/server/scanMemory/canonical'
import { extractScanMemory, type ScanMemoryPayload } from '../lib/server/scanMemory/extract'
import { SCAN_MEMORY_TIMEOUT_MS, persistScanMemoryPayload, scheduleScanMemory } from '../lib/server/scanMemory/persist'
import { TOKEN_RISK_METHODOLOGY_VERSION } from '../lib/server/riskScore'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from '../lib/server/tokenPublicResponse'

const TEST_PROJECT = 'wttoqlldbohidkkcmiws'
const FORBIDDEN_PROJECT = 'tactylskqlzmgwdgyval'
const URL_ = process.env.CORTEX_MEMORY_TEST_SUPABASE_URL
const RUN_HOSTED = process.env.CORTEX_MEMORY_RUN_HOSTED_TEST === '1'
// Dummy key: sent as the apikey header, whose value the agent proxy replaces with the Network secret. Not a credential.
const PLACEHOLDER_KEY = 'injected-by-agent-proxy'
// Injected into this test's writer calls only; generous enough for a round trip through the agent proxy.
const HOSTED_TIMEOUT_MS = 15_000
const SYNTHETIC_PREFIX = '0x00000000000000000000000000c0de'

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

/** fetch that sends only the dummy apikey for the agent proxy to replace, and no Authorization header. */
export const proxyCredentialFetch: typeof fetch = (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  headers.set('apikey', PLACEHOLDER_KEY)
  headers.delete('authorization')
  return fetch(input instanceof Request ? input.url : input, { ...init, method: init?.method ?? (input instanceof Request ? input.method : undefined), headers })
}

// Synthetic token: fixed recognisable prefix + a per-run suffix, so reruns never collide and cleanup is exact.
const RUN = randomBytes(6).toString('hex')
const TOKEN = `${SYNTHETIC_PREFIX}${RUN}`.slice(0, 42)
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

test('requests carry only the dummy apikey for the proxy to replace', async () => {
  const realFetch = globalThis.fetch
  let seen: Headers | null = null
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => { seen = new Headers(init?.headers); return new Response('[]') }) as typeof fetch
  try {
    const client = createClient(`https://${TEST_PROJECT}.supabase.co`, PLACEHOLDER_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: proxyCredentialFetch } })
    await client.from('scan_memory_daily').select('day').limit(1)
    assert.ok(seen)
    assert.equal((seen as Headers).get('apikey'), PLACEHOLDER_KEY)
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
  const leftover = await client.from('scan_memory').select('token_address').like('token_address', `${SYNTHETIC_PREFIX}%`).limit(5)
  assert.equal(leftover.error, null)
  assert.deepEqual(leftover.data, [], 'synthetic rows from an earlier run remain: delete them in the SQL editor first')
  assert.ok(HOSTED_TIMEOUT_MS > SCAN_MEMORY_TIMEOUT_MS)
  console.info(JSON.stringify({ evt: 'scan_memory_hosted_test', project: TEST_PROJECT, token: TOKEN }))

  // Every database call, including one the writer stopped waiting for, is tracked until it settles.
  const inflight = new Set<Promise<unknown>>()
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    void p.then(() => inflight.delete(p), () => inflight.delete(p))
    return p
  }
  const settle = async () => { while (inflight.size) await Promise.allSettled([...inflight]) }
  // Exactly the call the app makes (lib/server/scanMemory/persist.ts defaultRpc).
  const rpc = (payload: ScanMemoryPayload) => track((async () => {
    const { data, error } = await client.rpc('record_scan_memory', { p_payload: payload })
    if (error) throw new Error('scan_memory_rpc')
    return data as { outcome?: string; reason?: string } | null
  })())
  const logs: string[] = []
  const info = console.info, error = console.error
  console.info = (l: string) => { logs.push(l) }
  console.error = (l: string) => { logs.push(l) }
  process.env.CORTEX_SCAN_MEMORY_ENABLED = 'true' // this test process only
  t.after(async () => {
    await settle()
    console.info = info; console.error = error; delete process.env.CORTEX_SCAN_MEMORY_ENABLED
    info(`All database calls settled. Remove this run's synthetic rows in the ${TEST_PROJECT} SQL editor (owner role):\n` +
      `  delete from public.scan_memory where token_address = '${TOKEN}';`)
  })
  const lastLog = () => JSON.parse(logs.at(-1)!) as { outcome: string; reason?: string }
  const run = async (s: unknown) => {
    let work: (() => unknown) | null = null
    scheduleScanMemory(s, { after: (w) => { work = w }, rpc, timeoutMs: HOSTED_TIMEOUT_MS })
    assert.ok(work)
    const p = (work as () => unknown)()
    assert.ok(p instanceof Promise, 'after() receives the write promise')
    await p
  }
  const rows = async () => {
    await settle()
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
    assert.equal(r[0].evidence_hash, (extractScanMemory(scan()) as { payload: ScanMemoryPayload }).payload.evidence_hash)
  })
  await t.test('changed evidence: a new row with a different hash', async () => {
    logs.length = 0
    await run(scan({ riskScore: 55, riskLabel: 'Caution' }))
    assert.equal(lastLog().outcome, 'accepted')
    const r = await rows()
    assert.equal(r.length, 2)
    assert.notEqual(r[0].evidence_hash, r[1].evidence_hash)
    const changed = extractScanMemory(scan({ riskScore: 55, riskLabel: 'Caution' }))
    assert.ok(changed.ok)
    assert.equal(r[1].evidence_hash, changed.payload.evidence_hash)
    assert.equal(Number(r[1].risk_score), 55)
  })
  await t.test('tampered hash is rejected by the database', async () => {
    const e = extractScanMemory(scan({ riskScore: 40 }))
    assert.ok(e.ok)
    logs.length = 0
    await persistScanMemoryPayload({ ...e.payload, evidence_hash: 'f'.repeat(64) }, rpc, HOSTED_TIMEOUT_MS)
    assert.deepEqual(lastLog(), { event: 'scan_memory', outcome: 'skipped', reason: 'invalid_signal' })
    assert.equal((await rows()).length, 2)
  })
  await t.test('error isolation: a database error and a hung call never throw', async () => {
    const e = extractScanMemory(scan({ riskScore: 41 }))
    assert.ok(e.ok)
    logs.length = 0
    // A real error response from this database (the function does not exist), with nothing written.
    await persistScanMemoryPayload(e.payload, (p) => track((async () => {
      const { data, error: err } = await client.rpc('record_scan_memory_does_not_exist', { p_payload: p })
      if (err) throw new Error('scan_memory_rpc')
      return data as { outcome?: string } | null
    })()), HOSTED_TIMEOUT_MS)
    assert.deepEqual(lastLog(), { event: 'scan_memory', outcome: 'failed', reason: 'db_error' })
    logs.length = 0
    await persistScanMemoryPayload(e.payload, () => new Promise(() => undefined)) // no database call; production budget
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
  })
})
