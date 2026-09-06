import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export type OwnedAffiliate = {
  id: string
  referral_code: string
  status: string
  commission_rate: number | null
  created_at: string | null
  approved_at: string | null
}

const OWNED_FIELDS = 'id, referral_code, status, commission_rate, created_at, approved_at'

/** Ensure one affiliate row belongs to an authenticated user. The unique user_id index is the
 * final concurrency guard; a losing request reads and returns the row created by the winner. */
export async function ensureAffiliateForUser(
  sb: SupabaseClient,
  user: { id: string; email: string },
): Promise<OwnedAffiliate> {
  const byUserId = async () => {
    const result = await sb.from('affiliates').select(OWNED_FIELDS).eq('user_id', user.id).maybeSingle()
    if (result.error) throw result.error
    return result.data as OwnedAffiliate | null
  }

  const existing = await byUserId()
  if (existing) return existing

  // Preserve a legacy applicant's original code. Only an unattached row can be claimed, and the
  // user_id unique index makes concurrent claims/creates converge on one owned row.
  const legacy = await sb
    .from('affiliates')
    .select('id')
    .ilike('email', user.email)
    .is('user_id', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (legacy.error) throw legacy.error

  if (legacy.data?.id) {
    const attached = await sb
      .from('affiliates')
      .update({ user_id: user.id })
      .eq('id', legacy.data.id)
      .is('user_id', null)
      .select(OWNED_FIELDS)
      .maybeSingle()
    if (!attached.error && attached.data) return attached.data as OwnedAffiliate
    if (attached.error?.code !== '23505') throw attached.error
    const winner = await byUserId()
    if (winner) return winner
  }

  // Match the established application generator: `cl` plus eight random hex characters. Retry
  // referral-code collisions, while treating a user_id collision as a successful concurrent win.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = new Date().toISOString()
    const inserted = await sb
      .from('affiliates')
      .insert({
        user_id: user.id,
        email: user.email,
        referral_code: `cl${randomBytes(4).toString('hex')}`,
        status: 'approved',
        approved_at: now,
        commission_rate: 0.20,
      })
      .select(OWNED_FIELDS)
      .single()
    if (!inserted.error && inserted.data) return inserted.data as OwnedAffiliate
    if (inserted.error?.code !== '23505') throw inserted.error
    const winner = await byUserId()
    if (winner) return winner
  }

  throw new Error('Could not allocate a unique affiliate referral code.')
}
