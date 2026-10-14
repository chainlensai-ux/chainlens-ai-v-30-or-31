// One-off: bulk-import whale wallets into the existing `tracked_wallets` table — the same table the
// Whale Alerts sync (app/api/whale-alerts/sync/route.ts) scans. Rows are written as shared system
// wallets exactly the way sync selects them: user_id NULL, chain_id 8453 (Base), is_active true.
//
//   npx tsx scripts/import-whale-wallets.ts --dry-run   # parse, dedupe, check DB, print — no writes
//   npx tsx scripts/import-whale-wallets.ts             # insert new wallets
//
// Input: wallets-raw.txt at the repo root (gitignored). Credentials: NEXT_PUBLIC_SUPABASE_URL (or
// SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY from .env.local. Server-side script only; the key is
// never printed and this file is not imported by any app code.
//
// Upsert note: tracked_wallets no longer has a unique constraint on `address` (the FOMO migration
// dropped it for per-user tracking), so `upsert(..., { onConflict: 'address' })` would be rejected
// by Postgres. The script gets the same idempotency by reading existing system addresses first and
// inserting only the new ones; re-running it inserts nothing.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

// Addresses that must never be imported (routers, contracts, …). Add more here, lowercase or not.
const BLOCKLIST: string[] = [
  '0x1111111111166b7fe7bd91427724b487980afc69', // 1inch router
]

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const BASE_CHAIN_ID = 8453
const BATCH_SIZE = 25
const LABEL = 'Imported whale'
const SOURCE = 'manual'
const ROOT = path.resolve(__dirname, '..')

export type WalletImportPlan = {
  found: number
  duplicatesRemoved: number
  blocked: string[]
  unique: string[]
}

/**
 * Every 0x + 40 hex match, globally — two addresses pasted with no separator yield two matches;
 * usernames, timestamps and numbering never match. Lowercased, deduped, blocklist/zero removed.
 */
export function planWalletImport(raw: string, blocklist: readonly string[] = BLOCKLIST): WalletImportPlan {
  const matches = (raw.match(/0x[a-fA-F0-9]{40}/g) ?? []).map((a) => a.toLowerCase())
  const deduped = [...new Set(matches)]
  const blockedSet = new Set([...blocklist.map((a) => a.trim().toLowerCase()), ZERO_ADDRESS])
  const blocked = deduped.filter((a) => blockedSet.has(a))
  return {
    found: matches.length,
    duplicatesRemoved: matches.length - deduped.length,
    blocked,
    unique: deduped.filter((a) => !blockedSet.has(a)),
  }
}

function loadEnvLocal(): void {
  const envPath = path.join(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!process.env[key]) process.env[key] = value
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const rawPath = path.join(ROOT, 'wallets-raw.txt')
  if (!existsSync(rawPath)) {
    console.error(`wallets-raw.txt not found at ${rawPath}`)
    process.exit(1)
  }

  const plan = planWalletImport(readFileSync(rawPath, 'utf8'))
  console.log(`Addresses found:        ${plan.found}`)
  console.log(`Duplicates removed:     ${plan.duplicatesRemoved}`)
  console.log(`Blocked:                ${plan.blocked.length}${plan.blocked.length ? ` (${plan.blocked.join(', ')})` : ''}`)
  console.log(`Unique after blocklist: ${plan.unique.length}`)

  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRole) {
    if (dryRun) {
      console.log('Already existing:       not checked (no Supabase credentials in .env.local)')
      console.log(`Would insert (max):     ${plan.unique.length}`)
      console.log('\nFinal list:')
      for (const a of plan.unique) console.log(`  ${a}`)
      console.log('\nDry run — nothing written.')
      return
    }
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }

  const supabase = createClient(url, serviceRole, { auth: { persistSession: false } })

  // Existing shared (system) wallets — the set sync scans. A user's private FOMO row for the same
  // address does not count: it is visible only to that user.
  const existing = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('tracked_wallets')
      .select('address')
      .is('user_id', null)
      .range(from, from + 999)
    if (error) {
      console.error(`Failed to read existing wallets: ${error.code ?? ''} ${error.message}`)
      process.exit(1)
    }
    for (const row of (data ?? []) as Array<{ address: string | null }>) {
      if (row.address) existing.add(row.address.trim().toLowerCase())
    }
    if (!data || data.length < 1000) break
  }

  const alreadyExisting = plan.unique.filter((a) => existing.has(a))
  const toInsert = plan.unique.filter((a) => !existing.has(a))
  console.log(`Already existing:       ${alreadyExisting.length}`)
  console.log(`${dryRun ? 'Would insert:          ' : 'To insert:             '} ${toInsert.length}`)

  if (dryRun) {
    console.log('\nFinal list (new wallets):')
    for (const a of toInsert) console.log(`  ${a}`)
    console.log('\nDry run — nothing written.')
    return
  }

  let inserted = 0
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE).map((address) => ({
      address,
      wallet_address: address,
      chain_id: BASE_CHAIN_ID,
      user_id: null,
      label: LABEL,
      source: SOURCE,
      is_active: true,
    }))
    const { data, error } = await supabase.from('tracked_wallets').insert(batch).select('address')
    if (error) {
      console.error(`Batch ${i / BATCH_SIZE + 1} failed after ${inserted} inserted: ${error.code ?? ''} ${error.message}`)
      process.exit(1)
    }
    inserted += data?.length ?? 0
    console.log(`Batch ${i / BATCH_SIZE + 1}: inserted ${data?.length ?? 0}`)
  }
  console.log(`Inserted:               ${inserted}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
