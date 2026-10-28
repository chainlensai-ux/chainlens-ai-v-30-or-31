// Hosted check of the real CORTEX Memory writer against the ISOLATED Supabase test project only.
// Skipped unless both dedicated variables are set; it never reads the app's own Supabase variables:
//   CORTEX_MEMORY_TEST_SUPABASE_URL=https://wttoqlldbohidkkcmiws.supabase.co
//   CORTEX_MEMORY_TEST_SERVICE_ROLE_KEY=<service role key of that project>
// Before any write it proves the target is wttoqlldbohidkkcmiws and refuses the main ChainLens project.
// Synthetic evidence only (token addresses 0x…c0de…); no provider calls. Rows it writes are immutable to
// service_role by design; remove them afterwards with the owner-only statement printed at the end.
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
const KEY = process.env.CORTEX_MEMORY_TEST_SERVICE_ROLE_KEY

/** The project ref a key was issued for, when the key is a JWT (legacy service_role keys are). */
function keyProjectRef(key: string): string | null {
  const part = key.split('.')[1]
  if (!part) return null
  try { return (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { ref?: string }).ref ?? null } catch { return null }
}

export function assertIsolatedTarget(url: string | undefined, key: string | undefined): void {
  assert.ok(url && key, 'test credentials missing')
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'https:', 'https only')
  const host = parsed.host
  assert.ok(!url.includes(FORBIDDEN_PROJECT) && !key.includes(FORBIDDEN_PROJECT), 'refusing the main ChainLens database')
  assert.equal(host, `${TEST_PROJECT}.supabase.co`, `target must be ${TEST_PROJECT}`)
  const ref = keyProjectRef(key)
  if (ref != null) assert.equal(ref, TEST_PROJECT, 'the key belongs to a different project')
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) assert.notEqual(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host, host, 'the test target must not be the app database')
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

test('target guard refuses anything but the isolated project', () => {
  assert.throws(() => assertIsolatedTarget(`https://${FORBIDDEN_PROJECT}.supabase.co`, 'k'))
  assert.throws(() => assertIsolatedTarget('https://other.supabase.co', 'k'))
  assert.throws(() => assertIsolatedTarget(`https://${TEST_PROJECT}.supabase.co.example.com`, 'k'), 'look-alike host')
  assert.throws(() => assertIsolatedTarget(`http://${TEST_PROJECT}.supabase.co`, 'k'), 'https only')
  assert.throws(() => assertIsolatedTarget(`https://${TEST_PROJECT}.supabase.co`, `k-${FORBIDDEN_PROJECT}`))
  assert.throws(() => assertIsolatedTarget(undefined, 'k'))
  assert.throws(() => assertIsolatedTarget(`https://${TEST_PROJECT}.supabase.co`, undefined))
  const appUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${TEST_PROJECT}.supabase.co`
  try {
    assert.throws(() => assertIsolatedTarget(`https://${TEST_PROJECT}.supabase.co`, 'k'), 'never the app database, even if it is this project')
  } finally {
    if (appUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = appUrl
  }
  const forged = `x.${Buffer.from(JSON.stringify({ ref: FORBIDDEN_PROJECT })).toString('base64url')}.y`
  assert.throws(() => assertIsolatedTarget(`https://${TEST_PROJECT}.supabase.co`, forged))
  assert.doesNotThrow(() => assertIsolatedTarget(`https://${TEST_PROJECT}.supabase.co`, `x.${Buffer.from(JSON.stringify({ ref: TEST_PROJECT })).toString('base64url')}.y`))
})

test('real writer against the isolated Supabase project', { skip: !(URL_ && KEY) }, async (t) => {
  assertIsolatedTarget(URL_, KEY)
  const client = createClient(URL_!, KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  // Read-only proof the migration is installed on this target before anything is written.
  const probe = await client.from('scan_memory_daily').select('day').limit(1)
  assert.equal(probe.error, null, `scan_memory_daily not readable on ${TEST_PROJECT}: ${probe.error?.message}`)
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
  await t.test('error isolation: a rejected key and a hung call never throw', async () => {
    const e = extractScanMemory(scan({ riskScore: 41 }))
    assert.ok(e.ok)
    const bad = createClient(URL_!, 'invalid-key', { auth: { persistSession: false, autoRefreshToken: false } })
    logs.length = 0
    await persistScanMemoryPayload(e.payload, async (p) => {
      const { data, error: err } = await bad.rpc('record_scan_memory', { p_payload: p })
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
