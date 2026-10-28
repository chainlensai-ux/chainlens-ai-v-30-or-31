// End-to-end: the real scheduleScanMemory → extractScanMemory → persistScanMemoryPayload → record_scan_memory path
// against the real migration in PostgreSQL (PGlite). Synthetic scans only; no provider calls.
// Run with OUTCOME_PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RISK_INPUT_KEYS } from '../lib/server/scanMemory/canonical'
import { extractScanMemory, type ScanMemoryPayload } from '../lib/server/scanMemory/extract'
import { persistScanMemoryPayload, scheduleScanMemory } from '../lib/server/scanMemory/persist'
import { TOKEN_RISK_METHODOLOGY_VERSION } from '../lib/server/riskScore'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from '../lib/server/tokenPublicResponse'

const TOKEN = `0x${'ab'.repeat(20)}`
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

test('real writer path against the real migration', { skip: !process.env.OUTCOME_PGLITE_MODULE }, async (t) => {
  const { PGlite } = await import(process.env.OUTCOME_PGLITE_MODULE!)
  const { pgcrypto } = await import(process.env.OUTCOME_PGLITE_MODULE!.replace(/dist\/index\.js$/, 'dist/contrib/pgcrypto.js'))
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;`)
  await db.exec(readFileSync(new URL('../docs/migrations/20261028_scan_memory.sql', import.meta.url), 'utf8'))

  // The same call supabase-js makes: rpc('record_scan_memory', { p_payload }) as service_role.
  const rpc = async (payload: ScanMemoryPayload) => {
    await db.exec('set role service_role')
    try {
      return (await db.query('select public.record_scan_memory($1::jsonb) as r', [JSON.stringify(payload)])).rows[0].r as { outcome?: string; reason?: string }
    } finally {
      await db.exec('reset role')
    }
  }
  const logs: string[] = []
  const info = console.info, error = console.error
  console.info = (l: string) => { logs.push(l) }
  console.error = (l: string) => { logs.push(l) }
  process.env.CORTEX_SCAN_MEMORY_ENABLED = 'true'
  t.after(() => { console.info = info; console.error = error; delete process.env.CORTEX_SCAN_MEMORY_ENABLED })

  // Runs scheduleScanMemory exactly as the route does, then waits for the work it handed to after().
  const pending: Array<unknown> = []
  const runScheduled = async (s: unknown) => {
    let cb: (() => unknown) | null = null
    scheduleScanMemory(s, { after: (work) => { cb = work }, rpc })
    assert.ok(cb, 'work was handed to after()')
    const returned = (cb as () => unknown)()
    pending.push(returned)
    await returned
    return returned
  }
  const rows = async () => (await db.query('select evidence_hash, seen_count, coverage from public.scan_memory order by inserted_at')).rows as Array<{ evidence_hash: string; seen_count: number; coverage: string }>
  const lastLog = () => JSON.parse(logs.at(-1)!) as { outcome: string; reason?: string }

  await t.test('insertion: accepted, and the stored hash equals the TypeScript hash', async () => {
    logs.length = 0
    await runScheduled(scan())
    assert.equal(lastLog().outcome, 'accepted')
    const extracted = extractScanMemory(scan())
    assert.ok(extracted.ok)
    assert.equal((await rows())[0].evidence_hash, extracted.payload.evidence_hash)
  })

  await t.test('deduplication: the same evidence in the same 15-minute bucket is one row, seen twice', async () => {
    logs.length = 0
    await runScheduled(scan())
    assert.equal(lastLog().outcome, 'deduplicated')
    const r = await rows()
    assert.equal(r.length, 1)
    assert.equal(Number(r[0].seen_count), 2)
  })

  await t.test('changed evidence: a different risk score is a new row with a different hash', async () => {
    logs.length = 0
    await runScheduled(scan({ riskScore: 55, riskLabel: 'Caution' }))
    assert.equal(lastLog().outcome, 'accepted')
    const r = await rows()
    assert.equal(r.length, 2)
    assert.notEqual(r[0].evidence_hash, r[1].evidence_hash)
  })

  await t.test('a tampered hash is rejected by the database', async () => {
    const extracted = extractScanMemory(scan({ riskScore: 40 }))
    assert.ok(extracted.ok)
    logs.length = 0
    await persistScanMemoryPayload({ ...extracted.payload, evidence_hash: 'f'.repeat(64) }, rpc)
    assert.deepEqual(lastLog(), { event: 'scan_memory', outcome: 'skipped', reason: 'invalid_signal' })
    assert.equal((await rows()).length, 2)
  })

  await t.test('failures never throw: database error, timeout, and the flag off', async () => {
    const extracted = extractScanMemory(scan({ riskScore: 41 }))
    assert.ok(extracted.ok)
    logs.length = 0
    await persistScanMemoryPayload(extracted.payload, async () => { throw new Error('boom') })
    assert.deepEqual(lastLog(), { event: 'scan_memory', outcome: 'failed', reason: 'db_error' })
    logs.length = 0
    await persistScanMemoryPayload(extracted.payload, () => new Promise(() => undefined))
    assert.deepEqual(lastLog(), { event: 'scan_memory', outcome: 'failed', reason: 'db_timeout' })
    process.env.CORTEX_SCAN_MEMORY_ENABLED = 'TRUE'
    let called = false
    scheduleScanMemory(scan(), { after: () => { called = true }, rpc })
    assert.equal(called, false, 'anything but exactly "true" stays off')
    process.env.CORTEX_SCAN_MEMORY_ENABLED = 'true'
  })

  await t.test('safe cleanup: only expired rows are purged, at most the requested limit', async () => {
    await db.exec('alter table public.scan_memory disable trigger scan_memory_immutable_trigger')
    await db.exec(`update public.scan_memory set expires_at = now() - interval '1 day' where risk_score = 70`)
    await db.exec('alter table public.scan_memory enable trigger scan_memory_immutable_trigger')
    await db.exec('set role service_role')
    await assert.rejects(db.query('select public.purge_expired_scan_memory(5000)'), /1\.\.1000/)
    const purged = (await db.query('select public.purge_expired_scan_memory(1000) as n')).rows[0] as { n: number }
    await db.exec('reset role')
    assert.equal(Number(purged.n), 1)
    assert.equal((await rows()).length, 1, 'the unexpired row is kept')
  })

  await t.test("the callback given to after() returns the write's promise, so waitUntil tracks it", async () => {
    assert.ok(pending.length > 0)
    assert.ok(pending.every((p) => p instanceof Promise))
    await Promise.all(pending)
  })
})
