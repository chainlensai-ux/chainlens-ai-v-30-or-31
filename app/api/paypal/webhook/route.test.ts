import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { handlePayPalWebhook } from './route'

function request(body: object) {
  return new NextRequest('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'paypal-transmission-id': 'transmission',
      'paypal-transmission-sig': 'signature',
      'paypal-cert-url': 'https://example.com/cert',
    },
    body: JSON.stringify(body),
  })
}

function fakeClient(subscription: { user_id: string; plan: string } | null = null) {
  const marked: string[] = []
  return {
    marked,
    client: {
      from(table: string) {
        const query = {
          select() { return query },
          eq() { return query },
          async maybeSingle() {
            if (table === 'paypal_webhook_events') return { data: null, error: null }
            if (table === 'paypal_subscriptions') return { data: subscription, error: null }
            return { data: null, error: null }
          },
          async insert(row: { event_id: string }) {
            if (table === 'paypal_webhook_events') marked.push(row.event_id)
            return { error: null }
          },
        }
        return query
      },
    },
  }
}

async function run(body: object, client: ReturnType<typeof fakeClient>['client']) {
  const previousWebhookId = process.env.PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID
  process.env.PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID = 'webhook-id'
  try {
    return await handlePayPalWebhook(request(body), {
      getServiceClient: () => client as never,
      verifySignature: async () => true,
    })
  } finally {
    if (previousWebhookId === undefined) delete process.env.PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID
    else process.env.PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID = previousWebhookId
  }
}

test('SALE with an unknown billing agreement returns 500 without marking the event', async () => {
  const fake = fakeClient()
  const response = await run({
    id: 'WH-SALE-MISSING-SUB',
    event_type: 'PAYMENT.SALE.COMPLETED',
    resource: { id: 'SALE-1', billing_agreement_id: 'I-NOT-LOCAL' },
  }, fake.client)

  assert.equal(response.status, 500)
  assert.deepEqual(fake.marked, [])
})

test('plan-id mismatch is a retryable 500 and remains unmarked', async () => {
  const previousProPlan = process.env.PAYPAL_PRO_PLAN_ID
  process.env.PAYPAL_PRO_PLAN_ID = 'P-EXPECTED'
  const fake = fakeClient()
  try {
    const response = await run({
      id: 'WH-PLAN-MISMATCH',
      event_type: 'BILLING.SUBSCRIPTION.CREATED',
      resource: { id: 'I-1', custom_id: 'pro:user-1', plan_id: 'P-WRONG' },
    }, fake.client)
    assert.equal(response.status, 500)
    assert.deepEqual(fake.marked, [])
  } finally {
    if (previousProPlan === undefined) delete process.env.PAYPAL_PRO_PLAN_ID
    else process.env.PAYPAL_PRO_PLAN_ID = previousProPlan
  }
})
