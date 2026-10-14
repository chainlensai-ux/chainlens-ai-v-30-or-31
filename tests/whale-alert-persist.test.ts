// persistWhaleAlerts: the whale_alerts write ladder used by sync and the Alchemy webhook.
// Production regression: whale_alerts had no owner_user_id column (ownership migration unapplied),
// every sync upsert failed with PGRST204, and the feed stayed empty while the UI showed
// "db write failed: PGRST204".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { persistWhaleAlerts, type WhaleAlertsDb } from '../lib/server/whaleAlertPersist'

type Row = Record<string, unknown>
type Err = { code: string; message: string }

function fakeDb(opts: { upsertError?: Err; existing?: Row[]; insertError?: Err; selectError?: Err }) {
  const calls = { upserts: [] as Row[][], inserts: [] as Row[][], selects: [] as string[] }
  const db: WhaleAlertsDb = {
    from: () => ({
      upsert: (rows) => ({
        select: async () => {
          calls.upserts.push(rows)
          return opts.upsertError ? { data: null, error: opts.upsertError } : { data: rows.map((_, i) => ({ id: i })), error: null }
        },
      }),
      insert: (rows) => ({
        select: async () => {
          calls.inserts.push(rows)
          return opts.insertError ? { data: null, error: opts.insertError } : { data: rows.map((_, i) => ({ id: i })), error: null }
        },
      }),
      select: (columns) => ({
        in: async () => {
          calls.selects.push(columns)
          return opts.selectError ? { data: null, error: opts.selectError } : { data: opts.existing ?? [], error: null }
        },
      }),
    }),
  }
  return { db, calls }
}

const alert = (tx: string, owner: string | null = 'user-1'): Row => ({
  tx_hash: tx, wallet_address: '0xWALLET', token_address: '0xtoken', alert_type: 'token_transfer',
  amount_usd: 5000, occurred_at: '2026-10-14T00:00:00Z', owner_user_id: owner,
})
const MISSING_OWNER: Err = { code: 'PGRST204', message: "Could not find the 'owner_user_id' column of 'whale_alerts' in the schema cache" }

test('migrated DB: single ownership-keyed upsert, no fallback', async () => {
  const { db, calls } = fakeDb({})
  const r = await persistWhaleAlerts(db, [alert('0xa'), alert('0xb')])
  assert.deepEqual([r.path, r.inserted, r.skipped, r.error], ['upsert', 2, 0, null])
  assert.equal(calls.upserts.length, 1)
  assert.equal(calls.inserts.length, 0)
})

test('PGRST204 owner_user_id missing: system alerts are written ownerless (the bug that emptied the feed)', async () => {
  const { db, calls } = fakeDb({ upsertError: MISSING_OWNER })
  const r = await persistWhaleAlerts(db, [alert('0xa'), alert('0xb')])
  assert.deepEqual([r.path, r.inserted, r.error, r.recovered[0]?.code], ['legacy_no_owner', 2, null, 'PGRST204'])
  assert.equal(calls.inserts.length, 1)
  assert.ok(calls.inserts[0]!.every((row) => !('owner_user_id' in row)), 'owner column must not be sent to a DB without it')
  assert.equal(calls.selects[0], 'tx_hash,wallet_address,token_address,alert_type', 'legacy dedupe must not select the missing column')
})

test('legacy mode keeps dedup: rows already stored (case-insensitive key) are skipped, in-batch repeats collapse', async () => {
  const { db, calls } = fakeDb({
    upsertError: MISSING_OWNER,
    existing: [{ tx_hash: '0xA', wallet_address: '0xwallet', token_address: '0xTOKEN', alert_type: 'token_transfer' }],
  })
  const r = await persistWhaleAlerts(db, [alert('0xa'), alert('0xb'), alert('0xb')])
  assert.deepEqual([r.inserted, r.skipped], [1, 2])
  assert.deepEqual(calls.inserts[0]!.map((row) => row.tx_hash), ['0xb'])
})

test('legacy mode never writes a private (FOMO) alert ownerless — it would leak to every user', async () => {
  const { db, calls } = fakeDb({ upsertError: MISSING_OWNER })
  const priv = alert('0xp')
  const r = await persistWhaleAlerts(db, [alert('0xa'), priv], { isPrivate: (row) => row === priv })
  assert.deepEqual([r.inserted, r.privateDropped, r.skipped], [1, 1, 1])
  assert.deepEqual(calls.inserts[0]!.map((row) => row.tx_hash), ['0xa'])

  const onlyPrivate = fakeDb({ upsertError: MISSING_OWNER })
  const r2 = await persistWhaleAlerts(onlyPrivate.db, [priv], { isPrivate: () => true })
  assert.deepEqual([r2.inserted, r2.privateDropped, r2.error, onlyPrivate.calls.inserts.length], [0, 1, null, 0])
})

test('missing unique constraint (42P10): dedupe on the full ownership key then plain insert', async () => {
  const { db, calls } = fakeDb({
    upsertError: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' },
    existing: [{ tx_hash: '0xa', wallet_address: '0xwallet', token_address: '0xtoken', alert_type: 'token_transfer', owner_user_id: 'user-1' }],
  })
  const r = await persistWhaleAlerts(db, [alert('0xa'), alert('0xa', null)])
  assert.deepEqual([r.path, r.inserted, r.skipped], ['dedupe_insert', 1, 1])
  assert.equal(calls.inserts[0]![0]!.owner_user_id, null, 'a different owner is a different alert')
})

test('unrelated errors are surfaced, never silently degraded', async () => {
  for (const upsertError of [
    { code: '42501', message: 'permission denied for table whale_alerts' },
    { code: 'PGRST204', message: "Could not find the 'wallet_label' column of 'whale_alerts' in the schema cache" },
  ]) {
    const { db, calls } = fakeDb({ upsertError })
    const r = await persistWhaleAlerts(db, [alert('0xa')])
    assert.equal(r.error?.code, upsertError.code)
    assert.deepEqual([r.inserted, r.skipped, calls.inserts.length], [0, 1, 0])
  }
})

test('a failing legacy insert is reported as an error, not as "no fresh signal"', async () => {
  const { db } = fakeDb({ upsertError: MISSING_OWNER, insertError: { code: '23502', message: 'null value in column' } })
  const r = await persistWhaleAlerts(db, [alert('0xa')])
  assert.deepEqual([r.path, r.inserted, r.error?.code], ['legacy_no_owner', 0, '23502'])
})

test('empty batch makes no DB call', async () => {
  const { db, calls } = fakeDb({})
  const r = await persistWhaleAlerts(db, [])
  assert.deepEqual([r.inserted, calls.upserts.length], [0, 0])
})
