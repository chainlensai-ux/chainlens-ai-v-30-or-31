import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { missingColumnName, writeTrackedWallet } from '@/lib/server/trackedWalletWrite'

// User-owned tracked wallets. FOMO discovery is personal: adding a trader must never mutate the
// global tracker or make that trader appear in another account's wallet list.
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const BASE_CHAIN_ID = 8453
const BASE_CHAIN_SLUG = 'base'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

type ServiceClient = NonNullable<ReturnType<typeof getServiceClient>>

async function activeWalletCount(db: ServiceClient, userId: string): Promise<number | null> {
  const { count, error } = await db
    .from('tracked_wallets')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('chain_id', BASE_CHAIN_ID)
    .eq('is_active', true)
  return error ? null : (count ?? null)
}

function addAudit(input: {
  userIdPresent: boolean
  sourceHandle: string | null
  rank: number | null
  solWallet: string | null
  evmWallet: string | null
  walletValid: boolean
}) {
  return {
    userIdPresent: input.userIdPresent,
    sourceHandle: input.sourceHandle,
    rank: input.rank,
    solWallet: input.solWallet,
    evmWallet: input.evmWallet,
    chainId: BASE_CHAIN_ID,
    walletValid: input.walletValid,
    duplicateForUser: false,
    insertAttempted: false,
    supabaseErrorCode: null as string | null,
    finalStatus: 'pending' as 'pending' | 'added' | 'duplicate' | 'error',
    failureReason: null as string | null,
    trackedWalletCountBefore: null as number | null,
    trackedWalletCountAfter: null as number | null,
  }
}

// GET is account-scoped. It renders each account's "Already added" state without leaking the
// addresses another customer tracks.
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request)
  if (!auth) return unauthorizedResponse()

  const db = getServiceClient()
  if (!db) return NextResponse.json({ ok: false, error: 'service_unavailable' }, { status: 503 })
  const query = (columns: string) => db
    .from('tracked_wallets')
    .select(columns)
    .eq('user_id', auth.userId)
    .eq('chain_id', BASE_CHAIN_ID)
    .eq('is_active', true)
  // Sync status per wallet (last_scanned_at is a later migration; without it every wallet reads pending).
  let result = await query('wallet_address,source,source_handle,added_at,last_scanned_at')
  if (result.error) result = await query('wallet_address')
  if (result.error) console.error('[tracked-wallets] list failed', result.error.code, result.error.message)
  const { data, error } = result
  if (error) return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const wallets = rows
    .filter((row) => typeof row.wallet_address === 'string')
    .map((row) => ({
      address: (row.wallet_address as string).toLowerCase(),
      source: typeof row.source === 'string' ? row.source : null,
      handle: typeof row.source_handle === 'string' ? row.source_handle : null,
      addedAt: typeof row.added_at === 'string' ? row.added_at : null,
      lastScannedAt: typeof row.last_scanned_at === 'string' ? row.last_scanned_at : null,
      // Never scanned since it was added = its activity has not been checked yet.
      syncStatus: typeof row.last_scanned_at === 'string' && (typeof row.added_at !== 'string' || row.last_scanned_at >= row.added_at) ? 'synced' : 'pending',
    }))
  const addresses = wallets.map((w) => w.address)
  return NextResponse.json({ ok: true, addresses, wallets, count: addresses.length }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}

// Removing a wallet deactivates the caller's own row only (never the shared system set). The feed stops
// showing that wallet's private alerts and its FOMO badge on the next read.
export async function DELETE(request: Request) {
  const auth = await requireAuthenticatedUser(request)
  if (!auth) return unauthorizedResponse()
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const raw = typeof body?.address === 'string' ? body.address.trim() : new URL(request.url).searchParams.get('address')?.trim() ?? ''
  if (!EVM_ADDRESS_RE.test(raw)) return NextResponse.json({ ok: false, error: 'A valid EVM wallet address is required.' }, { status: 400 })
  const db = getServiceClient()
  if (!db) return NextResponse.json({ ok: false, error: 'service_unavailable' }, { status: 503 })
  const { data, error } = await db
    .from('tracked_wallets')
    .update({ is_active: false })
    .eq('user_id', auth.userId)
    .eq('chain_id', BASE_CHAIN_ID)
    .eq('wallet_address', raw.toLowerCase())
    .eq('is_active', true)
    .select('id')
  if (error) return NextResponse.json({ ok: false, error: 'Could not remove this wallet.' }, { status: 500 })
  return NextResponse.json({ ok: true, removed: (data ?? []).length > 0 })
}

export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request)
  if (!auth) return unauthorizedResponse()

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const rawAddress = typeof body?.address === 'string' ? body.address.trim() : ''
  const sourceHandle = typeof body?.sourceHandle === 'string' ? body.sourceHandle.trim().slice(0, 100) || null : null
  const sourceRank = typeof body?.sourceRank === 'number' && Number.isFinite(body.sourceRank) ? Math.floor(body.sourceRank) : null
  const sourceWindow = typeof body?.fomoWindow === 'string' ? body.fomoWindow.trim().slice(0, 20) || null : null
  const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 200) || null : (sourceHandle ? `FOMO: ${sourceHandle}` : null)
  const solWallet = typeof body?.solWallet === 'string' ? body.solWallet.trim().slice(0, 100) || null : null
  const normalizedAddress = EVM_ADDRESS_RE.test(rawAddress) ? rawAddress.toLowerCase() : null
  const audit = addAudit({
    userIdPresent: true,
    sourceHandle,
    rank: sourceRank,
    solWallet,
    evmWallet: normalizedAddress,
    walletValid: normalizedAddress != null,
  })

  if (!normalizedAddress) {
    audit.finalStatus = 'error'
    audit.failureReason = 'invalid_or_unresolved_evm_wallet'
    return NextResponse.json({ ok: false, error: 'A resolved EVM wallet address is required.', fomoAddWalletAudit: audit }, { status: 400 })
  }
  if (auth.plan === 'free') {
    audit.finalStatus = 'error'
    audit.failureReason = 'plan_blocked'
    return NextResponse.json({ ok: false, error: 'Included in Pro and Elite.', fomoAddWalletAudit: audit }, { status: 403 })
  }

  const db = getServiceClient()
  if (!db) {
    audit.finalStatus = 'error'
    audit.failureReason = 'service_unavailable'
    return NextResponse.json({ ok: false, error: 'Service unavailable.', fomoAddWalletAudit: audit }, { status: 503 })
  }

  audit.trackedWalletCountBefore = await activeWalletCount(db, auth.userId)
  const { data: existing, error: lookupError } = await db
    .from('tracked_wallets')
    .select('id,is_active')
    .eq('user_id', auth.userId)
    .eq('chain_id', BASE_CHAIN_ID)
    .eq('wallet_address', normalizedAddress)
    .maybeSingle()
  if (lookupError) {
    audit.finalStatus = 'error'
    audit.supabaseErrorCode = lookupError.code ?? null
    const missing = missingColumnName(lookupError)
    // Per-user tracking needs docs/migrations/20260904_fomo_user_scoped_tracked_wallets.sql.
    audit.failureReason = missing ? `tracked_wallets_missing_column:${missing}` : 'wallet_lookup_failed'
    console.error('[tracked-wallets] lookup failed', lookupError.code, lookupError.message)
    return NextResponse.json({
      ok: false,
      error: missing ? `Tracker database is missing the "${missing}" column (FOMO migration not applied).` : 'Could not check your tracked wallets.',
      fomoAddWalletAudit: audit,
    }, { status: missing ? 503 : 500 })
  }
  if (existing?.is_active) {
    audit.duplicateForUser = true
    audit.finalStatus = 'duplicate'
    audit.trackedWalletCountAfter = audit.trackedWalletCountBefore
    return NextResponse.json({ ok: true, status: 'duplicate', alreadyTracked: true, fomoAddWalletAudit: audit })
  }

  const now = new Date().toISOString()
  const row = {
    // address stays populated for the existing Base sync integrations; wallet_address is the
    // canonical per-user field protected by the user/chain/address unique index.
    address: normalizedAddress,
    wallet_address: normalizedAddress,
    user_id: auth.userId,
    chain_id: BASE_CHAIN_ID,
    chain_slug: BASE_CHAIN_SLUG,
    source: 'fomo_board',
    source_handle: sourceHandle,
    source_rank: sourceRank,
    fomo_window: sourceWindow,
    label,
    category: 'fomo_trader',
    tags: ['fomo', 'social_trader'],
    is_active: true,
    added_at: now,
  }
  audit.insertAttempted = true
  const write = await writeTrackedWallet(row, (r) => existing
    ? db.from('tracked_wallets').update(r).eq('id', existing.id)
    : db.from('tracked_wallets').insert(r))
  const writeError = write.error
  if (write.droppedColumns.length > 0) console.warn('[tracked-wallets] saved without missing optional columns', write.droppedColumns.join(','))
  if (writeError) {
    audit.supabaseErrorCode = writeError.code ?? null
    console.error('[tracked-wallets] write failed', writeError.code, writeError.message)
    if (writeError.code === '23505') {
      // A legacy unique(address) constraint (pre-20260904 schema) blocks a per-user row when the address
      // is already in the shared system set. It is then already scanned for every account.
      const { data: shared } = await db.from('tracked_wallets').select('id').eq('address', normalizedAddress).is('user_id', null).eq('is_active', true).limit(1)
      if ((shared ?? []).length > 0) {
        audit.finalStatus = 'duplicate'
        audit.failureReason = 'already_in_shared_set'
        return NextResponse.json({ ok: true, status: 'duplicate', alreadyTracked: true, sharedWallet: true, fomoAddWalletAudit: audit })
      }
    }
    audit.finalStatus = 'error'
    audit.failureReason = write.missingRequired ? `tracked_wallets_missing_column:${write.missingRequired}`
      : writeError.code === '23505' ? 'duplicate_constraint' : 'wallet_insert_failed'
    audit.trackedWalletCountAfter = await activeWalletCount(db, auth.userId)
    const error = write.missingRequired
      ? `Tracker database is missing the "${write.missingRequired}" column (FOMO migration not applied).`
      : writeError.code === '23505' ? 'This wallet is already tracked under another record.'
      : 'Could not save this wallet to your tracker.'
    return NextResponse.json({ ok: false, error, fomoAddWalletAudit: { ...audit, droppedColumns: write.droppedColumns } }, { status: write.missingRequired ? 503 : 500 })
  }

  audit.finalStatus = 'added'
  audit.trackedWalletCountAfter = await activeWalletCount(db, auth.userId)
  return NextResponse.json({ ok: true, status: 'added', alreadyTracked: false, fomoAddWalletAudit: audit })
}
