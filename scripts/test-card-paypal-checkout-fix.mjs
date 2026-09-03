// Card/PayPal checkout fix — behavior tests.
//
// Root cause of "clicking Card redirects to PayPal login": lib/pricingPlans.ts's cardCheckoutUrl
// and the PayPal flow's own endpoint were the SAME URL ('/api/paypal/create-subscription'). The
// pricing page's "Card" button silently ran the real PayPal Subscriptions flow and redirected the
// browser to PayPal's hosted approval page, which — with no distinct card checkout ever having
// existed — falls back to "log in to your PayPal account" (the "Use Face ID or Touch ID" screen).
//
// Fix: paypalCheckoutUrl and cardCheckoutUrl are now genuinely different endpoints. PayPal keeps
// the real, working Subscriptions flow. Card points at a new, honest route
// (app/api/checkout/card/route.ts) that requires a signed-in user like every other checkout route,
// but always 503s "not configured" — CARD_CHECKOUT_AVAILABLE (lib/pricingPlans.ts) is the single
// source of truth the UI reads too, so Card is shown disabled with a clear reason instead of lying.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handleCreateCardCheckout } from '../app/api/checkout/card/route.ts'
import { handleCreateSubscription } from '../app/api/paypal/create-subscription/route.ts'
import { CARD_CHECKOUT_AVAILABLE, pricingPlans } from '../lib/pricingPlans.ts'

process.env.PAYPAL_CLIENT_ID = 'test-client-id'
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret'
process.env.PAYPAL_PRO_PLAN_ID = 'P-PRO-PLAN-ID'
process.env.PAYPAL_ELITE_PLAN_ID = 'P-ELITE-PLAN-ID'
process.env.PAYPAL_ENV = 'sandbox'
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example'

const pricingSrc = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

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

function makeFakeServiceClient() {
  return {
    from() {
      const builder = {
        select() { return builder },
        eq() { return builder },
        in() { return builder },
        limit() { return builder },
        async maybeSingle() { return { data: null, error: null } }, // no existing subscription
      }
      return builder
    },
  }
}

const originalFetch = globalThis.fetch
function mockPayPalFetch() {
  const createCalls = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/v1/oauth2/token')) {
      return { ok: true, json: async () => ({ access_token: 'fake-token', expires_in: 3600 }) }
    }
    if (u.includes('/v1/billing/subscriptions')) {
      const body = JSON.parse(init.body)
      createCalls.push(body)
      return { ok: true, json: async () => ({ id: 'SUB-123', links: [{ rel: 'approve', href: 'https://paypal.example/approve/SUB-123' }] }) }
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  return createCalls
}
function restoreFetch() { globalThis.fetch = originalFetch }

let ipCounter = 0
function cardRequest(body, headers = {}) {
  ipCounter += 1
  return new Request('https://app.example/api/checkout/card', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${ipCounter}`, ...headers },
    body: JSON.stringify(body),
  })
}
function paypalRequest(body, headers = {}) {
  ipCounter += 1
  return new Request('https://app.example/api/paypal/create-subscription', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.2.0.${ipCounter}`, ...headers },
    body: JSON.stringify(body),
  })
}

async function run() {
  console.log('\nSection 1: Card and PayPal are genuinely different endpoints (the original bug)')
  {
    const pro = pricingPlans.find((p) => p.id === 'pro')
    const elite = pricingPlans.find((p) => p.id === 'elite')
    check('Pro: cardCheckoutUrl !== paypalCheckoutUrl', pro.cardCheckoutUrl !== pro.paypalCheckoutUrl)
    check('Elite: cardCheckoutUrl !== paypalCheckoutUrl', elite.cardCheckoutUrl !== elite.paypalCheckoutUrl)
    check('Pro: paypalCheckoutUrl is the real PayPal Subscriptions endpoint', pro.paypalCheckoutUrl === '/api/paypal/create-subscription')
    check('Elite: paypalCheckoutUrl is the real PayPal Subscriptions endpoint', elite.paypalCheckoutUrl === '/api/paypal/create-subscription')
    check('Pro: cardCheckoutUrl is its own distinct route', pro.cardCheckoutUrl === '/api/checkout/card')
    check('Elite: cardCheckoutUrl is its own distinct route', elite.cardCheckoutUrl === '/api/checkout/card')
    check('Card is not claimed available until a real provider is wired', CARD_CHECKOUT_AVAILABLE === false)
  }

  console.log('\nSection 2: Card checkout requires a signed-in user (same as PayPal/crypto) — logged-out cannot create checkout')
  {
    const anon = makeFakeAnonClient({})
    const noHeaderRes = await handleCreateCardCheckout(cardRequest({ plan: 'pro' }), { getAnonClient: () => anon })
    check('no Authorization header → 401', noHeaderRes.status === 401)
    const badTokenRes = await handleCreateCardCheckout(cardRequest({ plan: 'pro' }, { authorization: 'Bearer bad-token' }), { getAnonClient: () => anon })
    check('invalid token → 401', badTokenRes.status === 401)
  }

  console.log('\nSection 3: Card never returns a working checkout/redirect URL, and never claims success — honest 503')
  {
    const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
    for (const plan of ['pro', 'elite']) {
      const res = await handleCreateCardCheckout(cardRequest({ plan }, { authorization: 'Bearer good-token' }), { getAnonClient: () => anon })
      const json = await res.json()
      check(`${plan}: Card responds 503 (not configured), never 200`, res.status === 503)
      check(`${plan}: Card response carries no approvalUrl/checkoutUrl to redirect to`, json.approvalUrl === undefined && json.checkoutUrl === undefined)
      check(`${plan}: Card error message is honest, not a fabricated success`, typeof json.error === 'string' && /not configured/i.test(json.error))
    }
  }

  console.log('\nSection 4: Card checkout is never a redirect to PayPal — no PayPal URL, no PayPal call, ever')
  {
    const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
    const res = await handleCreateCardCheckout(cardRequest({ plan: 'pro' }, { authorization: 'Bearer good-token' }), { getAnonClient: () => anon })
    const json = await res.json()
    check('Card response never mentions paypal.com', !JSON.stringify(json).toLowerCase().includes('paypal.com'))
  }

  console.log('\nSection 5: no PayPal/provider secret ever appears in a Card response')
  {
    const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
    const res = await handleCreateCardCheckout(cardRequest({ plan: 'pro' }, { authorization: 'Bearer good-token' }), { getAnonClient: () => anon })
    const text = JSON.stringify(await res.json())
    for (const secretLike of ['PAYPAL_CLIENT_SECRET', 'client_secret', 'sk_live', 'sk_test']) {
      check(`Card response never contains "${secretLike}"`, !text.includes(secretLike))
    }
  }

  console.log('\nSection 6: Pro and Elite PayPal checkout both use the real, monthly Subscriptions API (never a one-time payment)')
  {
    for (const [plan, expectedPlanId] of [['pro', 'P-PRO-PLAN-ID'], ['elite', 'P-ELITE-PLAN-ID']]) {
      const createCalls = mockPayPalFetch()
      const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
      const service = makeFakeServiceClient()
      const res = await handleCreateSubscription(
        paypalRequest({ plan }, { authorization: 'Bearer good-token' }),
        { getAnonClient: () => anon, getServiceClient: () => service },
      )
      restoreFetch()
      const json = await res.json()
      check(`${plan}: PayPal checkout creation succeeds (200)`, res.status === 200)
      check(`${plan}: real PayPal Billing Plan id used (subscription, not a one-time order)`, createCalls[0]?.plan_id === expectedPlanId)
      check(`${plan}: PayPal call hits /v1/billing/subscriptions (recurring Subscriptions API, not /v1/checkout/orders)`, createCalls.length === 1)
      check(`${plan}: response returns a real approvalUrl to redirect the browser to`, typeof json.approvalUrl === 'string' && json.approvalUrl.length > 0)
    }
    const paypalLibSrc = readFileSync(new URL('../lib/paypal.ts', import.meta.url), 'utf8')
    check('createPayPalSubscription posts to the recurring Subscriptions API (/v1/billing/subscriptions), never a one-time /v1/checkout/orders', /\/v1\/billing\/subscriptions/.test(paypalLibSrc) && !/\/v1\/checkout\/orders/.test(paypalLibSrc))
    check('subscription is tagged SUBSCRIBE_NOW (recurring approval), not a one-time capture flow', /user_action: 'SUBSCRIBE_NOW'/.test(paypalLibSrc))
  }

  console.log('\nSection 7: a frontend redirect alone never activates a plan — only server-confirmed state does')
  {
    check('the PayPal return redirect (?paypal_subscription=approved) is handled by polling the server for the real plan, not by trusting the redirect itself', /params\.get\('paypal_subscription'\)/.test(pricingSrc) && /fetchCurrentPlan\(token\)/.test(pricingSrc))
    check('fetchCurrentPlan reads the plan from the server API (/api/user-settings), never from client/redirect state', /fetch\('\/api\/user-settings'/.test(pricingSrc))
    const startCheckoutSrc = pricingSrc.slice(pricingSrc.indexOf('async function startCheckout'), pricingSrc.indexOf('  return (\n    <div'))
    check('startCheckout only ever navigates the browser to the provider URL — it never calls setUserPlan itself', startCheckoutSrc.length > 0 && !/setUserPlan\(/.test(startCheckoutSrc))
    check('startCheckout redirects via window.location.href, not by writing local plan state', /window\.location\.href = parsedRedirect\.toString\(\)/.test(startCheckoutSrc))
  }

  console.log(`\n${passed} assertions passed`)
}

run().catch((err) => { console.error(err); process.exit(1) })
