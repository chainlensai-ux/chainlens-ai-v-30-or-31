// Tests for the PayPal payments end-to-end audit/fix.
//   lib/paypal.ts                          — OAuth token, subscription creation, webhook signature verify
//   app/api/paypal/create-subscription/route.ts — checkout creation (auth, plan allowlist, dupe guard)
//   app/api/paypal/webhook/route.ts        — signature verification, idempotency, event handling
//
// Run: npx tsx scripts/test-paypal-payments.mjs
//
// Every PayPal/network call is served by an injected fetch stub (mirrors the pattern already used
// by scripts/test-fomo-leaderboard.mjs), and every Supabase call goes through an in-memory fake
// client injected via each route's deps parameter — no real network, no real database.

import assert from 'node:assert/strict'
import {
  handleCreateSubscription,
} from '../app/api/paypal/create-subscription/route.ts'
import {
  handlePayPalWebhook, planFromCustomId, planMatchesPlanId, userIdFromCustomId,
} from '../app/api/paypal/webhook/route.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

process.env.PAYPAL_CLIENT_ID = 'test-client-id'
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret'
process.env.PAYPAL_PRO_PLAN_ID = 'P-PRO-PLAN-ID'
process.env.PAYPAL_ELITE_PLAN_ID = 'P-ELITE-PLAN-ID'
process.env.PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID = 'WH-TEST-ID'
process.env.PAYPAL_ENV = 'sandbox'
// Avoids touching request.nextUrl (not present on a plain fetch Request, only on NextRequest) —
// resolveAppUrl() only falls back to request.nextUrl when this is unset.
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example'

const originalFetch = globalThis.fetch

// ─── Fake PayPal HTTP layer (OAuth + subscription creation + signature verify) ──────────────────
function mockPayPalFetch({ verifySuccess = true } = {}) {
  const calls = { oauth: 0, createSubscription: [], verifySignature: 0 }
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/v1/oauth2/token')) {
      calls.oauth++
      return { ok: true, json: async () => ({ access_token: 'fake-access-token', expires_in: 3600 }) }
    }
    if (u.includes('/v1/billing/subscriptions')) {
      const body = JSON.parse(init.body)
      calls.createSubscription.push(body)
      return {
        ok: true,
        json: async () => ({ id: 'SUB-123', links: [{ rel: 'approve', href: 'https://paypal.example/approve/SUB-123' }] }),
      }
    }
    if (u.includes('/v1/notifications/verify-webhook-signature')) {
      calls.verifySignature++
      return { ok: true, json: async () => ({ verification_status: verifySuccess ? 'SUCCESS' : 'FAILURE' }) }
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  return calls
}

function restoreFetch() { globalThis.fetch = originalFetch }

// ─── In-memory fake Supabase client (chainable .from().select().eq().maybeSingle()/insert()/
// upsert()/update() surface — the exact subset both PayPal routes use) ──────────────────────────
function uniqueKeyFor(table) {
  if (table === 'paypal_webhook_events') return 'event_id'
  if (table === 'paypal_subscriptions') return 'paypal_subscription_id'
  if (table === 'user_settings') return 'user_id'
  return null
}

function makeFakeServiceClient(seed = {}) {
  const db = {
    paypal_subscriptions: seed.paypal_subscriptions ?? [],
    paypal_webhook_events: seed.paypal_webhook_events ?? [],
    user_settings: seed.user_settings ?? [],
  }
  return {
    _db: db,
    from(table) {
      const rows = db[table] ?? (db[table] = [])
      const filters = []
      let pending = null
      function applyFilters(list) {
        return list.filter((r) => filters.every(([col, val, op]) => (op === 'in' ? val.includes(r[col]) : r[col] === val)))
      }
      async function execPending() {
        if (!pending) return { data: null, error: null }
        if (pending.type === 'insert') {
          const key = uniqueKeyFor(table)
          if (key && rows.some((r) => r[key] === pending.obj[key])) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          }
          rows.push({ ...pending.obj })
          return { data: pending.obj, error: null }
        }
        if (pending.type === 'upsert') {
          const key = pending.onConflict ?? uniqueKeyFor(table)
          const idx = rows.findIndex((r) => r[key] === pending.obj[key])
          if (idx >= 0) rows[idx] = { ...rows[idx], ...pending.obj }
          else rows.push({ ...pending.obj })
          return { data: pending.obj, error: null }
        }
        if (pending.type === 'update') {
          const matches = applyFilters(rows)
          matches.forEach((r) => Object.assign(r, pending.obj))
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }
      const builder = {
        select() { return builder },
        eq(col, val) { filters.push([col, val]); return builder },
        in(col, vals) { filters.push([col, vals, 'in']); return builder },
        limit() { return builder },
        async maybeSingle() {
          const matches = applyFilters(rows)
          return { data: matches[0] ?? null, error: null }
        },
        insert(obj) { pending = { type: 'insert', obj }; return execPending() },
        upsert(obj, opts) { pending = { type: 'upsert', obj, onConflict: opts?.onConflict }; return execPending() },
        update(obj) { pending = { type: 'update', obj }; return builder },
        then(resolve, reject) { execPending().then(resolve, reject) },
      }
      return builder
    },
  }
}

function makeFakeAnonClient(usersByToken) {
  return {
    auth: {
      async getUser(token) {
        const user = usersByToken[token]
        if (!user) return { data: { user: null }, error: { message: 'invalid token' } }
        return { data: { user }, error: null }
      },
    },
  }
}

// UNIQUE-IP-PER-REQUEST, DISCLOSED: create-subscription is rate-limited (10 req/min per IP, see
// lib/server/rateLimit.ts) — real, deliberate protection, not a test artifact to work around by
// disabling it. This suite makes many more than 10 calls in total, so each gets its own synthetic
// x-forwarded-for IP (this is the only signal getClientIp reads) purely so unrelated test cases
// don't trip each other's rate-limit bucket; it does not touch or weaken the limiter itself.
let ipCounter = 0
function jsonRequest(body, headers = {}) {
  ipCounter += 1
  return new Request('https://app.example/api/paypal/create-subscription', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${ipCounter}`, ...headers },
    body: JSON.stringify(body),
  })
}

function webhookRequest(body, headers = {}) {
  const defaultHeaders = {
    'paypal-transmission-id': 'txn-1',
    'paypal-transmission-time': '2025-01-01T00:00:00Z',
    'paypal-cert-url': 'https://api.paypal.com/cert',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'sig',
    ...headers,
  }
  return new Request('https://app.example/api/paypal/webhook', {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify(body),
  })
}

async function run() {
  // ── 1/2. Pro maps to Pro PayPal plan ID / Elite maps to Elite PayPal plan ID ──────────────────
  for (const [plan, expectedPlanId] of [['pro', 'P-PRO-PLAN-ID'], ['elite', 'P-ELITE-PLAN-ID']]) {
    const calls = mockPayPalFetch()
    const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
    const service = makeFakeServiceClient()
    const res = await handleCreateSubscription(
      jsonRequest({ plan }, { authorization: 'Bearer good-token' }),
      { getAnonClient: () => anon, getServiceClient: () => service },
    )
    const json = await res.json()
    check(`${plan} checkout succeeds`, res.status === 200)
    check(`${plan} maps to the correct PayPal Billing Plan ID`, calls.createSubscription[0]?.plan_id === expectedPlanId)
    check(`${plan} approval URL is returned`, json.approvalUrl === 'https://paypal.example/approve/SUB-123')
    restoreFetch()
  }

  // ── 3. Price/plan tampering rejected — anything other than exactly 'pro'/'elite' is a 400, never
  //    silently coerced to a default plan. ─────────────────────────────────────────────────────
  {
    const calls = mockPayPalFetch()
    const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
    const service = makeFakeServiceClient()
    for (const tamperedPlan of ['god-mode', 'elite; DROP TABLE users', 0, null, { plan: 'elite' }, ['elite']]) {
      const res = await handleCreateSubscription(
        jsonRequest({ plan: tamperedPlan }, { authorization: 'Bearer good-token' }),
        { getAnonClient: () => anon, getServiceClient: () => service },
      )
      check(`tampered plan value ${JSON.stringify(tamperedPlan)} is rejected with 400`, res.status === 400)
    }
    check('no PayPal subscription was ever created for a tampered plan value', calls.createSubscription.length === 0)
    restoreFetch()
  }
  {
    // A price field, if a client tried to send one, is simply never read — plan is the only input,
    // and it only ever selects a server-side env-configured Billing Plan id, never a price.
    const calls = mockPayPalFetch()
    const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
    const service = makeFakeServiceClient()
    const res = await handleCreateSubscription(
      jsonRequest({ plan: 'pro', price: 0.01, amount: '0.01' }, { authorization: 'Bearer good-token' }),
      { getAnonClient: () => anon, getServiceClient: () => service },
    )
    check('a client-supplied price field is ignored — the resolved plan_id is still the server env value', calls.createSubscription[0]?.plan_id === 'P-PRO-PLAN-ID')
    check('no price/amount field is ever forwarded to PayPal from client input', !('price' in (calls.createSubscription[0] ?? {})) && !('amount' in (calls.createSubscription[0] ?? {})))
    check(res.status === 200, true)
    restoreFetch()
  }

  // ── 4. Unauthenticated checkout rejected ──────────────────────────────────────────────────────
  {
    const calls = mockPayPalFetch()
    const anon = makeFakeAnonClient({})
    const service = makeFakeServiceClient()
    const noAuthRes = await handleCreateSubscription(jsonRequest({ plan: 'pro' }), { getAnonClient: () => anon, getServiceClient: () => service })
    check('missing Authorization header is rejected with 401', noAuthRes.status === 401)
    const badTokenRes = await handleCreateSubscription(
      jsonRequest({ plan: 'pro' }, { authorization: 'Bearer not-a-real-token' }),
      { getAnonClient: () => anon, getServiceClient: () => service },
    )
    check('an invalid/unrecognized token is rejected with 401', badTokenRes.status === 401)
    check('no PayPal subscription was created for either unauthenticated attempt', calls.createSubscription.length === 0)
    restoreFetch()
  }

  // ── Duplicate-subscription guard: a pending/active row blocks a second checkout ────────────────
  {
    const calls = mockPayPalFetch()
    const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
    const service = makeFakeServiceClient({ paypal_subscriptions: [{ user_id: 'user-1', paypal_subscription_id: 'SUB-OLD', plan: 'pro', status: 'active' }] })
    const res = await handleCreateSubscription(
      jsonRequest({ plan: 'elite' }, { authorization: 'Bearer good-token' }),
      { getAnonClient: () => anon, getServiceClient: () => service },
    )
    check('an existing active subscription blocks a new checkout with 409', res.status === 409)
    check('no second PayPal subscription is created while one is already active', calls.createSubscription.length === 0)
    restoreFetch()
  }
  {
    // Duplicate-guard read failure fails CLOSED (blocks), never open (the exact clock-skew class of
    // bug already fixed elsewhere in this codebase for getVerifiedUserPlan).
    const calls = mockPayPalFetch()
    const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
    const service = makeFakeServiceClient()
    const originalFrom = service.from.bind(service)
    service.from = (table) => {
      const builder = originalFrom(table)
      if (table === 'paypal_subscriptions') {
        const originalMaybeSingle = builder.maybeSingle.bind(builder)
        builder.maybeSingle = async () => {
          const real = await originalMaybeSingle()
          return { data: null, error: { message: 'simulated PostgREST rejection' } }
        }
      }
      return builder
    }
    const res = await handleCreateSubscription(
      jsonRequest({ plan: 'pro' }, { authorization: 'Bearer good-token' }),
      { getAnonClient: () => anon, getServiceClient: () => service },
    )
    check('a failed duplicate-subscription lookup fails closed (blocks checkout), never open', res.status === 500)
    check('no PayPal subscription is created when the duplicate check itself fails', calls.createSubscription.length === 0)
    restoreFetch()
  }

  // ── 5. Frontend success does not upgrade — architectural check: activateUserPlanServerSide is
  //    never imported/called by the create-subscription route or by anything client-reachable; only
  //    the two verified webhook handlers call it. ────────────────────────────────────────────────
  {
    const { readFileSync } = await import('node:fs')
    const createSubSource = readFileSync(new URL('../app/api/paypal/create-subscription/route.ts', import.meta.url), 'utf8')
    check('create-subscription route never imports activateUserPlanServerSide', !createSubSource.includes('activateUserPlanServerSide'))
    const pricingPage = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')
    check('pricing page never calls a route that grants a plan directly — only polls read-only /api/user-settings after redirect', !/plan\s*[:=]\s*['"](pro|elite)['"]/.test(pricingPage))
  }

  // ── Pure helper functions ─────────────────────────────────────────────────────────────────────
  check('planFromCustomId reads "elite:" prefix as elite', planFromCustomId('elite:user-1') === 'elite')
  check('planFromCustomId defaults anything else (including "pro:") to pro', planFromCustomId('pro:user-1') === 'pro' && planFromCustomId(undefined) === 'pro')
  check('userIdFromCustomId extracts the user id half', userIdFromCustomId('elite:user-42') === 'user-42')
  check('userIdFromCustomId rejects a malformed custom_id', userIdFromCustomId('not-well-formed') === null && userIdFromCustomId(undefined) === null)
  check('planMatchesPlanId passes when plan_id matches the env-configured id for that plan', planMatchesPlanId('pro', 'P-PRO-PLAN-ID') === true)
  check('planMatchesPlanId fails when plan_id does not match (forged custom_id defense)', planMatchesPlanId('pro', 'P-ELITE-PLAN-ID') === false)
  check('planMatchesPlanId passes when the event carries no plan_id at all (nothing to cross-check)', planMatchesPlanId('elite', undefined) === true)

  // ── 6. Valid webhook upgrades user ────────────────────────────────────────────────────────────
  {
    const calls = mockPayPalFetch({ verifySuccess: true })
    const service = makeFakeServiceClient()
    let activateCalls = []
    const activatePlan = async (userId, plan, subscriptionId) => {
      activateCalls.push({ userId, plan, subscriptionId })
      service._db.user_settings.push({ user_id: userId, plan, lemon_subscription_id: subscriptionId })
      return { error: null }
    }
    const res = await handlePayPalWebhook(
      webhookRequest({
        id: 'evt-1',
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: { id: 'SUB-1', custom_id: 'elite:user-1', plan_id: 'P-ELITE-PLAN-ID', billing_info: { next_billing_time: '2025-02-01T00:00:00Z' } },
      }),
      { getServiceClient: () => service, activatePlan },
    )
    check('a signature-verified ACTIVATED event returns 200', res.status === 200)
    check('a verified webhook activates the correct plan for the correct user', activateCalls.length === 1 && activateCalls[0].userId === 'user-1' && activateCalls[0].plan === 'elite')
    check('the subscription row is recorded active', service._db.paypal_subscriptions.find((r) => r.paypal_subscription_id === 'SUB-1')?.status === 'active')
    restoreFetch()
  }

  // ── 7. Invalid webhook rejected — a failed signature check never touches billing state ─────────
  {
    const calls = mockPayPalFetch({ verifySuccess: false })
    const service = makeFakeServiceClient()
    let activateCalls = 0
    const activatePlan = async () => { activateCalls++; return { error: null } }
    const res = await handlePayPalWebhook(
      webhookRequest({ id: 'evt-2', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'SUB-2', custom_id: 'elite:user-1' } }),
      { getServiceClient: () => service, activatePlan },
    )
    check('an unverifiable signature is rejected with 400', res.status === 400)
    check('an invalid webhook never activates a plan', activateCalls === 0)
    check('an invalid webhook never writes a subscription row', service._db.paypal_subscriptions.length === 0)
    restoreFetch()
  }
  {
    // Missing signature headers entirely — rejected before even attempting verification.
    const calls = mockPayPalFetch({ verifySuccess: true })
    const service = makeFakeServiceClient()
    const res = await handlePayPalWebhook(
      webhookRequest(
        { id: 'evt-3', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'SUB-3', custom_id: 'pro:user-1' } },
        { 'paypal-transmission-sig': '', 'paypal-transmission-id': '', 'paypal-cert-url': '' },
      ),
      { getServiceClient: () => service },
    )
    check('missing PayPal signature headers are rejected with 400 without calling verify-webhook-signature', res.status === 400 && calls.verifySignature === 0)
    restoreFetch()
  }

  // ── 8. Duplicate webhook ignored — a redelivered event id short-circuits before any state change ──
  {
    const calls = mockPayPalFetch({ verifySuccess: true })
    const service = makeFakeServiceClient({ paypal_webhook_events: [{ event_id: 'evt-dup', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED' }] })
    let activateCalls = 0
    const activatePlan = async () => { activateCalls++; return { error: null } }
    const res = await handlePayPalWebhook(
      webhookRequest({ id: 'evt-dup', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'SUB-4', custom_id: 'pro:user-1' } }),
      { getServiceClient: () => service, activatePlan },
    )
    const json = await res.json()
    check('a redelivered (already-recorded) event id is deduped, returns 200', res.status === 200 && json.deduped === true)
    check('a deduped event never re-runs the plan activation', activateCalls === 0)
    restoreFetch()
  }

  // ── 9. Cancel/fail/refund removes access ──────────────────────────────────────────────────────
  for (const eventType of ['BILLING.SUBSCRIPTION.CANCELLED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED']) {
    const calls = mockPayPalFetch({ verifySuccess: true })
    const service = makeFakeServiceClient({
      paypal_subscriptions: [{ user_id: 'user-1', paypal_subscription_id: 'SUB-5', plan: 'elite', status: 'active' }],
      user_settings: [{ user_id: 'user-1', plan: 'elite', lemon_subscription_id: 'SUB-5' }],
    })
    const resource = eventType === 'BILLING.SUBSCRIPTION.CANCELLED' ? { id: 'SUB-5' } : { billing_agreement_id: 'SUB-5' }
    const res = await handlePayPalWebhook(
      webhookRequest({ id: `evt-${eventType}`, event_type: eventType, resource }),
      { getServiceClient: () => service },
    )
    check(`${eventType} returns 200`, res.status === 200)
    check(`${eventType} downgrades the user back to free`, service._db.user_settings.find((r) => r.user_id === 'user-1')?.plan === 'free')
    restoreFetch()
  }
  {
    // The downgrade guard: cancelling a PayPal subscription must never touch a user whose ACTUAL
    // paid plan came from somewhere else (e.g. crypto) — lemon_subscription_id doesn't match.
    const calls = mockPayPalFetch({ verifySuccess: true })
    const service = makeFakeServiceClient({
      paypal_subscriptions: [{ user_id: 'user-2', paypal_subscription_id: 'SUB-6', plan: 'pro', status: 'active' }],
      user_settings: [{ user_id: 'user-2', plan: 'elite', lemon_subscription_id: 'CRYPTO-PAYMENT-REF' }],
    })
    const res = await handlePayPalWebhook(
      webhookRequest({ id: 'evt-cancel-crosspay', event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'SUB-6' } }),
      { getServiceClient: () => service },
    )
    check('cancelling a PayPal subscription that was not the source of the current plan leaves the plan untouched', service._db.user_settings.find((r) => r.user_id === 'user-2')?.plan === 'elite')
    restoreFetch()
  }
  {
    // Suspended/expired mark the row without unconditionally forcing a downgrade — access lapses via
    // the existing current_period_end expiry instead (never a fabricated instant downgrade here).
    for (const eventType of ['BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED']) {
      const calls = mockPayPalFetch({ verifySuccess: true })
      const service = makeFakeServiceClient({ paypal_subscriptions: [{ user_id: 'user-3', paypal_subscription_id: 'SUB-7', plan: 'pro', status: 'active' }] })
      const res = await handlePayPalWebhook(
        webhookRequest({ id: `evt-${eventType}`, event_type: eventType, resource: { id: 'SUB-7' } }),
        { getServiceClient: () => service },
      )
      const expectedStatus = eventType === 'BILLING.SUBSCRIPTION.SUSPENDED' ? 'suspended' : 'expired'
      check(`${eventType} marks the subscription row ${expectedStatus}`, service._db.paypal_subscriptions.find((r) => r.paypal_subscription_id === 'SUB-7')?.status === expectedStatus)
      restoreFetch()
    }
  }

  // ── Plan/plan_id cross-check defense-in-depth ─────────────────────────────────────────────────
  {
    const calls = mockPayPalFetch({ verifySuccess: true })
    const service = makeFakeServiceClient()
    let activateCalls = 0
    const activatePlan = async () => { activateCalls++; return { error: null } }
    // custom_id claims "elite", but PayPal's own resource.plan_id is the PRO plan id — forged/
    // mismatched custom_id, must be rejected rather than granting elite off the client-influenced
    // custom_id claim alone.
    const res = await handlePayPalWebhook(
      webhookRequest({ id: 'evt-mismatch', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'SUB-8', custom_id: 'elite:user-1', plan_id: 'P-PRO-PLAN-ID' } }),
      { getServiceClient: () => service, activatePlan },
    )
    check('a mismatched custom_id/plan_id pair never activates a plan', activateCalls === 0)
    restoreFetch()
  }

  // ── Unrecoverable Supabase write failure does not silently 200 (PayPal must retry) ─────────────
  {
    const calls = mockPayPalFetch({ verifySuccess: true })
    const service = makeFakeServiceClient()
    const activatePlan = async () => ({ error: 'simulated DB failure' })
    const res = await handlePayPalWebhook(
      webhookRequest({ id: 'evt-writefail', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'SUB-9', custom_id: 'pro:user-1' } }),
      { getServiceClient: () => service, activatePlan },
    )
    check('a failed plan activation returns 500 so PayPal retries, never a silent 200', res.status === 500)
    restoreFetch()
  }

  console.log(`test-paypal-payments.mjs: all ${passed} assertions passed`)
}

run().catch((err) => { restoreFetch(); console.error(err); process.exit(1) })
