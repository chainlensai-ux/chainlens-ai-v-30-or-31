import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RISK_INPUT_KEYS, liquidityBandFromCents, usdToCents } from '../lib/server/scanMemory/canonical'
import { extractScanMemory, type ScanMemoryPayload } from '../lib/server/scanMemory/extract'
import { TOKEN_RISK_METHODOLOGY_VERSION } from '../lib/server/riskScore'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from '../lib/server/tokenPublicResponse'

const TOKEN = `0x${'ab'.repeat(20)}`

function scan(token = TOKEN, overrides: Record<string, unknown> = {}) {
  return {
    chain: 'base',
    contract: token,
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
  }
}

function payload(token = TOKEN, overrides: Record<string, unknown> = {}): ScanMemoryPayload {
  const extracted = extractScanMemory(scan(token, overrides))
  if (!extracted.ok) throw new Error(extracted.reason)
  return extracted.payload
}

test('scan memory migration enforces cap, dedup, immutability and role isolation in PostgreSQL', { skip: !process.env.OUTCOME_PGLITE_MODULE }, async (t) => {
  const { PGlite } = await import(process.env.OUTCOME_PGLITE_MODULE!)
  const pgcryptoModule = process.env.OUTCOME_PGLITE_MODULE!.replace(/dist\/index\.js$/, 'dist/contrib/pgcrypto.js')
  const { pgcrypto } = await import(pgcryptoModule)
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
  `)
  await db.exec(readFileSync(new URL('../docs/migrations/20261028_scan_memory.sql', import.meta.url), 'utf8'))

  async function record(row: ScanMemoryPayload) {
    await db.exec('set role service_role')
    return db.query('select public.record_scan_memory($1::jsonb) as result', [JSON.stringify(row)])
  }

  await t.test('stored hash matches the TypeScript hash and observation time is not insertion time', async () => {
    const row = payload()
    const result = await record(row)
    assert.equal(result.rows[0].result.outcome, 'accepted')
    await db.exec('reset role')
    const stored = (await db.query(
      'select evidence_hash, observed_at, inserted_at, price_usd::text, liquidity_band from public.scan_memory',
    )).rows[0] as { evidence_hash: string; observed_at: string; inserted_at: string; price_usd: string; liquidity_band: number }
    assert.equal(stored.evidence_hash, row.evidence_hash)
    assert.equal(new Date(stored.observed_at).toISOString(), row.observed_at)
    assert.notEqual(new Date(stored.inserted_at).toISOString(), new Date(stored.observed_at).toISOString())
    const cents = usdToCents(Number(row.liquidity_usd))!
    const bandRow = (await db.query('select public.scan_memory_liquidity_band($1::numeric) as band', [row.liquidity_usd])).rows[0] as { band: number }
    const sqlBand = Number(bandRow.band)
    assert.equal(sqlBand, liquidityBandFromCents(cents))
    assert.equal(stored.liquidity_band, sqlBand)
  })

  await t.test('identical concurrent calls create one row and a later repeat still counts at the cap', async () => {
    const row = payload()
    const [first, second] = await Promise.all([record(row), record(row)])
    const outcomes = [first.rows[0].result.outcome, second.rows[0].result.outcome].sort()
    assert.deepEqual(outcomes, ['deduplicated', 'deduplicated'])
    await db.exec('reset role')
    const seen = (await db.query('select seen_count, count(*) over () as rows from public.scan_memory')).rows[0] as { seen_count: number; rows: number }
    assert.equal(Number(seen.rows), 1)
    assert.equal(Number(seen.seen_count), 3)
    await db.exec(`update public.scan_memory_daily set accepted_count = 2000`)
    const repeat = await record(row)
    const other = await record(payload(`0x${'cd'.repeat(20)}`))
    assert.equal(repeat.rows[0].result.outcome, 'deduplicated')
    assert.equal(other.rows[0].result.outcome, 'capped')
    await db.exec('reset role')
    assert.equal(Number((await db.query('select count(*)::int as n from public.scan_memory')).rows[0].n), 1)
  })

  await t.test('zero price is null, partial coverage stays partial, and evidence cannot be rewritten', async () => {
    await db.exec('reset role')
    await db.exec('delete from public.scan_memory')
    await db.exec('update public.scan_memory_daily set accepted_count = 0, dedup_count = 0, capped_count = 0')
    const row = payload(TOKEN, { priceUsd: 0, liquidityUsd: null, riskInputStatuses: { ...payload().risk_inputs, holders: 'partial' } })
    assert.equal(row.price_usd, null)
    assert.equal(row.liquidity_usd, null)
    assert.equal(row.coverage, 'partial')
    assert.equal((await record(row)).rows[0].result.outcome, 'accepted')
    await db.exec('reset role')
    const stored = (await db.query(
      `select price_usd::text, coverage, signal_json->'honeypot'->>'is_honeypot' as honeypot from public.scan_memory`,
    )).rows[0] as { price_usd: string | null; coverage: string; honeypot: string }
    assert.equal(stored.price_usd, null)
    assert.equal(stored.coverage, 'partial')
    assert.equal(stored.honeypot, 'false')
    await assert.rejects(db.exec(`update public.scan_memory set risk_score = 1`), /immutable/)
    await assert.rejects(db.exec(`update public.scan_memory set signal_json = '{}'::jsonb`), /immutable/)
  })

  await t.test('service role cannot write tables directly and anonymous callers cannot read or execute', async () => {
    await db.exec('set role service_role')
    await assert.rejects(db.exec(`insert into public.scan_memory(scanner_version, risk_methodology_version, chain, token_address, observed_at, observed_bucket, expires_at, coverage, risk_score, evidence_hash, dedup_key, signal_json) values ('token_scanner_response:8','evm_token_risk_score:v1','base','${TOKEN}',now(),now(),now(),'complete',1,repeat('a',64),repeat('b',64),'{}')`), /permission denied/)
    await assert.rejects(db.exec('update public.scan_memory_daily set cap = 999999'), /permission denied/)
    await db.exec('set role anon')
    await assert.rejects(db.query('select * from public.scan_memory'), /permission denied/)
    await assert.rejects(db.query('select public.record_scan_memory($1::jsonb)', ['{}']), /permission denied/)
    await db.exec('set role authenticated')
    await assert.rejects(db.query('select * from public.scan_memory_daily'), /permission denied/)
  })

  await t.test('a forged user or extra field is rejected and fresh rows are not purged', async () => {
    await db.exec('reset role')
    const row = payload(`0x${'ef'.repeat(20)}`)
    const forged = { ...row, userId: 'user-1' }
    await db.exec('set role service_role')
    const rejected = await db.query('select public.record_scan_memory($1::jsonb) as result', [JSON.stringify(forged)])
    assert.equal(rejected.rows[0].result.outcome, 'skipped')
    assert.equal(rejected.rows[0].result.reason, 'invalid_signal')
    await db.exec('reset role')
    const before = Number((await db.query('select count(*)::int as n from public.scan_memory')).rows[0].n)
    await db.exec('set role service_role')
    const purged = await db.query('select public.purge_expired_scan_memory(1000) as n')
    assert.equal(purged.rows[0].n, 0)
    await db.exec('reset role')
    assert.equal(Number((await db.query('select count(*)::int as n from public.scan_memory')).rows[0].n), before)
  })

  const sql = readFileSync(new URL('../docs/migrations/20261028_scan_memory.sql', import.meta.url), 'utf8')
  assert.match(sql, /for update/)
  assert.match(sql, /unique_violation/)
  assert.equal(sql.includes('cap_override'), false)
})
