import { createClient } from '@supabase/supabase-js'
import { createAnonSupabaseClient, createAuthedSupabaseClient } from '@/lib/supabase/userSettings'
import { resolveEffectivePlan, type UserSettings } from '@/lib/supabase/userSettings'

export type ChainlensPlan = 'free' | 'pro' | 'elite'
export type ChainlensFeature =
  | 'token_screener' | 'basic_token_info' | 'clark_limited'
  | 'full_token_scanner' | 'wallet_scanner' | 'whale_alerts' | 'pump_alerts' | 'base_radar'

const RANK: Record<ChainlensPlan, number> = { free: 0, pro: 1, elite: 2 }
const FEATURE_MIN_PLAN: Record<ChainlensFeature, ChainlensPlan> = {
  token_screener: 'free', basic_token_info: 'free', clark_limited: 'free',
  full_token_scanner: 'pro', wallet_scanner: 'pro', whale_alerts: 'pro', pump_alerts: 'pro', base_radar: 'pro',
}

export function normalizePlan(value: unknown): ChainlensPlan {
  return value === 'pro' || value === 'elite' ? value : 'free'
}
export function canAccessFeature(plan: ChainlensPlan, feature: ChainlensFeature): boolean {
  return RANK[plan] >= RANK[FEATURE_MIN_PLAN[feature]]
}

function getServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRole) return null
  return createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })
}

const FREE_PLAN_RESULT = {
  plan: 'free' as ChainlensPlan,
  rawPlan: 'free' as ChainlensPlan,
  trialActive: false,
  trialEndsAt: null,
  userId: null as string | null,
  email: null as string | null,
  settingsRowFound: false,
}

export async function getCurrentUserPlanFromBearerToken(token: string) {
  const anon = createAnonSupabaseClient()
  if (!anon) return { ...FREE_PLAN_RESULT }
  const { data } = await anon.auth.getUser(token)
  const user = data.user
  if (!user) return { ...FREE_PLAN_RESULT }
  if (process.env.BETA_ALL_ELITE === 'true') {
    return {
      plan: 'elite' as ChainlensPlan,
      rawPlan: 'elite' as ChainlensPlan,
      trialActive: false,
      trialEndsAt: null,
      userId: user.id,
      email: user.email ?? null,
      settingsRowFound: true,
    }
  }
  // Identity is already verified via GoTrue getUser. PostgREST independently rejects the same
  // bearer token on clock-skew ("JWT issued at future"), which made Clark treat Elite as Free and
  // answer wallet scans with WALLET SCANNER LOCKED. Read settings with the service-role client
  // scoped to that userId — same pattern as GET /api/user-settings. Never user-suppliable.
  const admin = getServiceRoleClient()
  const settingsClient = admin ?? createAuthedSupabaseClient(token) ?? anon
  const { data: row } = await settingsClient
    .from('user_settings')
    .select('plan,subscription_status,trial_plan,trial_ends_at,current_period_end')
    .eq('user_id', user.id)
    .maybeSingle()
  const settingsRowFound = row !== null
  const trialEndsAt = typeof row?.trial_ends_at === 'string' ? row.trial_ends_at : null
  const trialActive = row?.trial_plan === 'elite' && Boolean(trialEndsAt) && Number.isFinite(Date.parse(trialEndsAt ?? '')) && Date.parse(trialEndsAt ?? '') > Date.now()
  return {
    plan: resolveEffectivePlan(row as Partial<UserSettings> | null),
    rawPlan: normalizePlan(row?.plan),
    trialActive,
    trialEndsAt,
    userId: user.id,
    email: user.email ?? null,
    settingsRowFound,
  }
}

export async function updatePlanServerSideByEmail(input: {
  email: string, plan: ChainlensPlan, lemonCustomerId?: string | null, lemonSubscriptionId?: string | null,
  lemonVariantId?: string | null, subscriptionStatus?: string | null, currentPeriodEnd?: string | null,
}) {
  const admin = getServiceRoleClient()
  if (!admin) return { ok: false, reason: 'missing_service_role' }
  const { data: user } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const found = user.users.find((u) => (u.email || '').toLowerCase() === input.email.toLowerCase())
  if (!found) return { ok: false, reason: 'user_not_found' }

  const payload = {
    user_id: found.id,
    plan: input.plan,
    lemon_customer_id: input.lemonCustomerId ?? null,
    lemon_subscription_id: input.lemonSubscriptionId ?? null,
    lemon_variant_id: input.lemonVariantId ?? null,
    subscription_status: input.subscriptionStatus ?? null,
    current_period_end: input.currentPeriodEnd ?? null,
    updated_at: new Date().toISOString(),
  }
  const { error } = await admin.from('user_settings').upsert(payload, { onConflict: 'user_id' })
  return { ok: !error, reason: error?.message }
}
