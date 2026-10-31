import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountScanRow, canonicalHistoryToken, persistAccountScan, retryAccountScan, type AccountScanRow } from '../lib/server/accountScanHistory'
import { calculateTokenRiskScore } from '../lib/server/riskScore'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const token = '0x' + 'a'.repeat(40)
const scan = () => { const risk = calculateTokenRiskScore({ contractFlags: { mint: { status: 'not_detected' }, blacklist: { status: 'not_detected' }, pause: { status: 'not_detected' } }, honeypot: { isHoneypot: false, sellTax: 0 } }); return { chain: 'base', contract: token, scanRequestId: 'scan-test-1', scanRequestStartedAt: Date.now(), scanResponseSchemaVersion: 11, riskMethodologyVersion: 'evm_token_risk_score:v2', ...risk, riskEngine: { confidence: risk.confidence }, riskEvidenceCoveragePercent: risk.evidenceCoveragePercent } }

test('only validated server snapshots persist; Solana token case is preserved', () => {
  assert.ok(accountScanRow(A, scan()))
  assert.equal(accountScanRow(A, { ...scan(), riskScore: 99 }), null)
  assert.equal(accountScanRow(A, { ...scan(), riskEvidenceCoveragePercent: 101 }), null)
  assert.equal(canonicalHistoryToken('solana', 'So11111111111111111111111111111111111111112'), 'So11111111111111111111111111111111111111112')
  const missing = { ...scan(), ...calculateTokenRiskScore({}), riskEvidenceCoveragePercent: 0, riskEngine: { confidence: 'low' } }
  assert.equal(accountScanRow(A, missing)?.risk_label, 'Unrated')
})

test('save failure is explicit and never reports confirmation', async () => {
  const r = await persistAccountScan(A, scan(), async () => { throw new Error('offline') })
  assert.equal(r.status, 'unavailable')
  assert.equal(r.observedAt, null)
})

test('manual retry preserves the original server observation and rejects tampering or another account', async () => {
  const previous = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-signing-key'
  try {
    const original = scan()
    const failed = await persistAccountScan(A, original, async () => { throw new Error('offline') })
    assert.ok(failed.retryToken)
    let calls = 0
    const save = async (row: AccountScanRow) => { calls++; assert.equal(row.scan_request_id, original.scanRequestId); assert.equal(row.observed_at, new Date(original.scanRequestStartedAt).toISOString()); return { observedAt: row.observed_at, duplicate: false } }
    assert.equal((await retryAccountScan(B, failed.retryToken, save)).status, 'ineligible')
    assert.equal((await retryAccountScan(A, failed.retryToken + '0', save)).status, 'ineligible')
    assert.equal(calls, 0)
    assert.equal((await retryAccountScan(A, failed.retryToken, save)).status, 'saved')
    assert.equal(calls, 1)
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previous
  }
})

test('real local PostgreSQL: disk persistence, concurrent duplicates, RLS and immutable account isolation', { skip: !process.env.CORTEX_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.CORTEX_PGLITE_MODULE!)
  const directory = mkdtempSync(join(tmpdir(), 'cortex-history-pg-'))
  let db = new PGlite(directory)
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values ('${A}'),('${B}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to authenticated;`)
  await db.exec(readFileSync('supabase/cortex-account-scan-history.sql', 'utf8'))
  const save = async (row: AccountScanRow) => {
    const columns = Object.keys(row)
    const values = columns.map(k => k === 'evidence_snapshot' ? JSON.stringify(row[k]) : row[k as keyof AccountScanRow])
    const inserted = await db.query(`insert into cortex_account_scan_history (${columns.join(',')}) values (${columns.map((_,i)=>'$'+(i+1)).join(',')}) on conflict (user_id,chain_id,token_address,scan_request_id) do nothing returning observed_at`, values)
    if (inserted.rows.length) return { observedAt: new Date(inserted.rows[0].observed_at).toISOString(), duplicate: false }
    const existing = await db.query('select observed_at from cortex_account_scan_history where user_id=$1 and chain_id=$2 and token_address=$3 and scan_request_id=$4', [row.user_id,row.chain_id,row.token_address,row.scan_request_id])
    return { observedAt: new Date(existing.rows[0].observed_at).toISOString(), duplicate: true }
  }
  const original = scan()
  const receipts = await Promise.all([persistAccountScan(A, original, save), persistAccountScan(A, original, save)])
  assert.deepEqual(receipts.map(r => r.status).sort(), ['duplicate', 'saved'])
  assert.equal(receipts[0].observedAt, receipts[1].observedAt)
  await persistAccountScan(B, original, save)
  const reused = await persistAccountScan(B, { ...original }, save)
  assert.equal(reused.status, 'duplicate', 'a second device/cache refresh reuses the same real observation')
  assert.equal(reused.observedAt, receipts[0].observedAt, 'cache reuse never invents a new observation time')
  const readAs = async (id: string) => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${id}',false);`)
    const rows = (await db.query('select user_id,risk_methodology_version,risk_score,confidence,coverage_percent from cortex_account_scan_history')).rows
    await db.exec('reset role')
    return rows
  }
  assert.deepEqual((await readAs(A)).map((r: any) => r.user_id), [A])
  assert.deepEqual((await readAs(B)).map((r: any) => r.user_id), [B])
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${A}',false);`)
  await assert.rejects(db.exec('delete from cortex_account_scan_history'))
  await assert.rejects(db.exec('update cortex_account_scan_history set risk_score=99'))
  await assert.rejects(db.exec(`insert into cortex_account_scan_history select * from cortex_account_scan_history`))
  await db.exec('reset role')
  await db.close()
  db = new PGlite(directory)
  assert.equal((await readAs(A)).length, 1, 'new connection after logout/process restart restores stored history')
  assert.equal((await readAs(B)).length, 1, 'second account/device can read only its own observation')
  const rows = (await db.query('select count(*)::int as n from cortex_account_scan_history')).rows
  assert.equal(rows[0].n, 2, 'login/read/refresh never inserts fake observations')
  await db.close()
})
