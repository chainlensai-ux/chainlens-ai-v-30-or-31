import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'

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
  const { data, error } = await db
    .from('tracked_wallets')
    .select('wallet_address')
    .eq('user_id', auth.userId)
    .eq('chain_id', BASE_CHAIN_ID)
    .eq('is_active', true)
  if (error) return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })

  const addresses = (data ?? [])
    .map((row) => typeof row.wallet_address === 'string' ? row.wallet_address.toLowerCase() : null)
    .filter((address): address is string => address != null)
  return NextResponse.json({ ok: true, addresses, count: addresses.length }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
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
    audit.failureReason = 'wallet_lookup_failed'
    return NextResponse.json({ ok: false, error: 'Could not check your tracked wallets.', fomoAddWalletAudit: audit }, { status: 500 })
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
  const { error: writeError } = existing
    ? await db.from('tracked_wallets').update(row).eq('id', existing.id)
    : await db.from('tracked_wallets').insert(row)
  if (writeError) {
    audit.finalStatus = 'error'
    audit.supabaseErrorCode = writeError.code ?? null
    audit.failureReason = writeError.code === '23505' ? 'duplicate_for_user' : 'wallet_insert_failed'
    audit.trackedWalletCountAfter = await activeWalletCount(db, auth.userId)
    return NextResponse.json({ ok: false, error: 'Could not save this wallet to your tracker.', fomoAddWalletAudit: audit }, { status: 500 })
  }

  audit.finalStatus = 'added'
  audit.trackedWalletCountAfter = await activeWalletCount(db, auth.userId)
  return NextResponse.json({ ok: true, status: 'added', alreadyTracked: false, fomoAddWalletAudit: audit })
}
