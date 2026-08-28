#!/usr/bin/env node
// ADMIN GRANT PLAN, DISCLOSED — one-off support script, not wired into any endpoint.
//
// Reused, not reinvented: calls the SAME updatePlanServerSideByEmail() helper (lib/supabase/plans.ts)
// that the real PayPal/crypto payment webhooks call to activate a paid plan — never a new ad hoc
// database write. Requires SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in the environment
// this script runs in (this sandbox does not have them — run this wherever the real production
// credentials live: locally with .env.local, or via `vercel env pull` first).
//
// subscription_status is set to 'active' to match how a real paid activation looks
// (lib/supabase/userSettings.ts's resolveEffectivePlan checks it for the paid-Elite branch).
// current_period_end is left null on purpose — per that same file's own disclosure, a null period
// end never expires; this is the documented shape for an admin-granted plan with no billing cycle
// attached. If this should expire on a schedule instead, pass --days=<n> (see below).
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... NEXT_PUBLIC_SUPABASE_URL=... \
//     npx tsx scripts/admin-grant-plan.mjs --email=chainlensai@gmail.com --plan=elite
//
// Optional:
//   --days=365       set an expiry (current_period_end) N days out instead of never-expiring
//   --dry-run        look up the user and print what WOULD change; makes no write

import { updatePlanServerSideByEmail } from '../lib/supabase/plans.ts'
import { createClient } from '@supabase/supabase-js'

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const email = arg('email')
const plan = arg('plan', 'elite')
const days = arg('days')
const dryRun = has('dry-run')

if (!email) {
  console.error('Usage: npx tsx scripts/admin-grant-plan.mjs --email=<address> [--plan=elite|pro] [--days=N] [--dry-run]')
  process.exit(1)
}
if (plan !== 'pro' && plan !== 'elite') {
  console.error(`--plan must be "pro" or "elite", got "${plan}"`)
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceRole) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY and/or NEXT_PUBLIC_SUPABASE_URL in this environment.')
  console.error('This sandbox does not have production credentials — run this where they do (local .env.local, or `vercel env pull` first).')
  process.exit(1)
}

const currentPeriodEnd = days ? new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString() : null

if (dryRun) {
  const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) { console.error('Lookup failed:', error.message); process.exit(1) }
  const found = data.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase())
  if (!found) { console.log(`DRY RUN: no user found for ${email} — nothing would change.`); process.exit(0) }
  const { data: row } = await admin.from('user_settings').select('plan,subscription_status,current_period_end').eq('user_id', found.id).maybeSingle()
  console.log(`DRY RUN — user found: ${found.id} (${email})`)
  console.log(`  current: plan=${row?.plan ?? '(none)'} subscription_status=${row?.subscription_status ?? '(none)'} current_period_end=${row?.current_period_end ?? '(none)'}`)
  console.log(`  would set: plan=${plan} subscription_status=active current_period_end=${currentPeriodEnd ?? '(never expires)'}`)
  process.exit(0)
}

const result = await updatePlanServerSideByEmail({
  email,
  plan,
  subscriptionStatus: 'active',
  currentPeriodEnd,
})

if (!result.ok) {
  console.error(`FAILED to set ${email} to ${plan}: ${result.reason}`)
  process.exit(1)
}

console.log(`OK — ${email} is now on the ${plan} plan (subscription_status=active, expires: ${currentPeriodEnd ?? 'never'}).`)
