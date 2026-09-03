// Card/PayPal checkout fix — behavior tests.
//
// Root cause of "clicking Card redirects to PayPal login": lib/pricingPlans.ts's cardCheckoutUrl
// and the PayPal flow's own endpoint were the SAME URL ('/api/paypal/create-subscription'), but
// there was no distinct card checkout ever available on PayPal's side and no guest checkout
// disclosure anywhere — the pricing page's "Card" button silently ran the real PayPal Subscriptions
// flow and redirected to PayPal's hosted approval page, which fell back to a PayPal login prompt.
//
// Per explicit instruction, Card now intentionally reuses the same PayPal Subscriptions endpoint —
// PayPal's own hosted checkout page can present a real card-entry form for a guest payer instead of
// forcing login, but ONLY once Guest Checkout / "Advanced Credit and Debit Card Payments" is enabled
// on the live PayPal Business account (an account-level PayPal setting this code cannot control —
// see CARD_CHECKOUT_AVAILABLE's own comment in lib/pricingPlans.ts). These tests verify the *routing*
// is correct (same real subscription, same plan ids, same auth/duplicate guards as PayPal) and that
// the audit still distinguishes which button the user clicked, even though the request is otherwise
// identical.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
function paypalRequest(body, headers = {}) {
  ipCounter += 1
  return new Request('https://app.example/api/paypal/create-subscription', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.2.0.${ipCounter}`, ...headers },
    body: JSON.stringify(body),
  })
}

async function run() {
  console.log('\nSection 1: Card and PayPal intentionally hit the same real PayPal Subscriptions endpoint')
  {
    const pro = pricingPlans.find((p) => p.id === 'pro')
    const elite = pricingPlans.find((p) => p.id === 'elite')
    check('Pro: cardCheckoutUrl === paypalCheckoutUrl (same real PayPal flow)', pro.cardCheckoutUrl === pro.paypalCheckoutUrl)
    check('Elite: cardCheckoutUrl === paypalCheckoutUrl (same real PayPal flow)', elite.cardCheckoutUrl === elite.paypalCheckoutUrl)
    check('Pro: cardCheckoutUrl is the real PayPal Subscriptions endpoint', pro.cardCheckoutUrl === '/api/paypal/create-subscription')
    check('Elite: cardCheckoutUrl is the real PayPal Subscriptions endpoint', elite.cardCheckoutUrl === '/api/paypal/create-subscription')
    check('Card is marked available (routing is correct — contingent on PayPal guest checkout being enabled on the account)', CARD_CHECKOUT_AVAILABLE === true)
  }

  console.log('\nSection 2: Card checkout requires a signed-in user (same as PayPal/crypto) — logged-out cannot create checkout')
  {
    const anon = makeFakeAnonClient({})
    const noHeaderRes = await handleCreateSubscription(paypalRequest({ plan: 'pro', method: 'card' }), { getAnonClient: () => anon })
    check('no Authorization header → 401', noHeaderRes.status === 401)
    const badTokenRes = await handleCreateSubscription(paypalRequest({ plan: 'pro', method: 'card' }, { authorization: 'Bearer bad-token' }), { getAnonClient: () => anon })
    check('invalid token → 401', badTokenRes.status === 401)
  }

  console.log('\nSection 3: Pro and Elite both work for Card and PayPal — same real, monthly Subscriptions API either way')
  {
    for (const method of ['card', 'paypal']) {
      for (const [plan, expectedPlanId] of [['pro', 'P-PRO-PLAN-ID'], ['elite', 'P-ELITE-PLAN-ID']]) {
        const createCalls = mockPayPalFetch()
        const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
        const service = makeFakeServiceClient()
        const res = await handleCreateSubscription(
          paypalRequest({ plan, method }, { authorization: 'Bearer good-token' }),
          { getAnonClient: () => anon, getServiceClient: () => service },
        )
        restoreFetch()
        const json = await res.json()
        check(`${method}/${plan}: checkout creation succeeds (200)`, res.status === 200)
        check(`${method}/${plan}: real PayPal Billing Plan id used (subscription, not a one-time order)`, createCalls[0]?.plan_id === expectedPlanId)
        check(`${method}/${plan}: hits /v1/billing/subscriptions (recurring Subscriptions API, not /v1/checkout/orders)`, createCalls.length === 1)
        check(`${method}/${plan}: response returns a real approvalUrl to redirect the browser to`, typeof json.approvalUrl === 'string' && json.approvalUrl.length > 0)
      }
    }
    const paypalLibSrc = readFileSync(new URL('../lib/paypal.ts', import.meta.url), 'utf8')
    check('createPayPalSubscription posts to the recurring Subscriptions API (/v1/billing/subscriptions), never a one-time /v1/checkout/orders', /\/v1\/billing\/subscriptions/.test(paypalLibSrc) && !/\/v1\/checkout\/orders/.test(paypalLibSrc))
    check('subscription is tagged SUBSCRIBE_NOW (recurring approval), not a one-time capture flow', /user_action: 'SUBSCRIBE_NOW'/.test(paypalLibSrc))
  }

  console.log('\nSection 4: the duplicate-subscription guard applies identically to Card and PayPal (same underlying subscription)')
  {
    const routeSrc = readFileSync(new URL('../app/api/paypal/create-subscription/route.ts', import.meta.url), 'utf8')
    check('duplicate guard runs before createPayPalSubscription regardless of which button was clicked (no method-based bypass)', /existingSubscription/.test(routeSrc) && !/method === 'card'[\s\S]{0,200}existingSubscription/.test(routeSrc))
  }

  console.log('\nSection 5: the audit still distinguishes Card vs PayPal even though the request is otherwise identical')
  {
    const routeSrc = readFileSync(new URL('../app/api/paypal/create-subscription/route.ts', import.meta.url), 'utf8')
    check('an audit-only `method` field is read from the request body', /body\.method === 'card'/.test(routeSrc))
    check('selectedPaymentMethod in the audit reflects the real uiMethod, not a hardcoded value', /selectedPaymentMethod: uiMethod/.test(routeSrc))
    check('the real backend provider is always recorded as paypal (PayPal processes the payment either way)', /provider: 'paypal',/.test(routeSrc))
  }

  console.log('\nSection 6: no PayPal/provider secret ever appears in a checkout response, Card or PayPal')
  {
    for (const method of ['card', 'paypal']) {
      mockPayPalFetch()
      const anon = makeFakeAnonClient({ 'good-token': { id: 'user-1' } })
      const service = makeFakeServiceClient()
      const res = await handleCreateSubscription(
        paypalRequest({ plan: 'pro', method }, { authorization: 'Bearer good-token' }),
        { getAnonClient: () => anon, getServiceClient: () => service },
      )
      restoreFetch()
      const text = JSON.stringify(await res.json())
      for (const secretLike of ['PAYPAL_CLIENT_SECRET', 'client_secret', 'sk_live', 'sk_test']) {
        check(`${method}: response never contains "${secretLike}"`, !text.includes(secretLike))
      }
    }
  }

  console.log('\nSection 7: a frontend redirect alone never activates a plan — only server-confirmed state does')
  {
    check('the PayPal return redirect (?paypal_subscription=approved) is handled by polling the server for the real plan, not by trusting the redirect itself', /params\.get\('paypal_subscription'\)/.test(pricingSrc) && /fetchCurrentPlan\(token\)/.test(pricingSrc))
    check('fetchCurrentPlan reads the plan from the server API (/api/user-settings), never from client/redirect state', /fetch\('\/api\/user-settings'/.test(pricingSrc))
    const startCheckoutSrc = pricingSrc.slice(pricingSrc.indexOf('async function startCheckout'), pricingSrc.indexOf('  return (\n    <div'))
    check('startCheckout only ever navigates the browser to the provider URL — it never calls setUserPlan itself', startCheckoutSrc.length > 0 && !/setUserPlan\(/.test(startCheckoutSrc))
    check('startCheckout redirects via window.location.href, not by writing local plan state', /window\.location\.href = parsedRedirect\.toString\(\)/.test(startCheckoutSrc))
  }

  console.log('\nSection 8: pricing UI wires Card as a real, clickable option — not a disabled placeholder')
  {
    check('Card button is wired to startCheckout, not permanently disabled', /startCheckout\(selectedPlanId, 'card'\)/.test(pricingSrc))
    check('Card copy is honest about what actually happens (via PayPal checkout)', /Pay by card via PayPal checkout/.test(pricingSrc))
    check('Card is only ever disabled by the shared CARD_CHECKOUT_AVAILABLE flag, not hardcoded true', /disabled=\{checkoutLoading !== null \|\| !CARD_CHECKOUT_AVAILABLE\}/.test(pricingSrc))
  }

  console.log(`\n${passed} assertions passed`)
}

run().catch((err) => { console.error(err); process.exit(1) })
