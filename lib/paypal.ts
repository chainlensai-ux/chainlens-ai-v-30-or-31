// Server-only module — real PayPal REST API (OAuth2, Transaction Search/Reporting API, and
// Subscriptions API). Never import from client components — PAYPAL_CLIENT_SECRET must never
// reach the browser.
//
// TWO SEPARATE PAYPAL INTEGRATIONS LIVE HERE, DISCLOSED:
// 1) One-time payments: a STATIC, pre-existing PayPal payment link (Native Checkout Page) plus
//    manual transaction-ID verification via the Reporting API (lookupPayPalTransaction below).
//    See docs/paypal-verification.md.
// 2) Recurring subscriptions: the real PayPal Subscriptions API (createPayPalSubscription +
//    verifyPayPalWebhookSignature below), reconciled via /api/paypal/webhook. This is a genuine
//    Orders/Subscriptions + webhook flow — unlike (1), it requires a real Billing Plan (plan_id)
//    configured in the PayPal Developer Dashboard, since PayPal has no API to create Billing
//    Plans without one already existing in most REST app configurations; this code creates
//    Subscriptions against that plan_id, not the plan itself.

const PAYPAL_ENV = (process.env.PAYPAL_ENV ?? 'sandbox').toLowerCase()
export const PAYPAL_API_BASE = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'

let cachedToken: { accessToken: string; expiresAt: number } | null = null

// OAuth2 client-credentials token, cached in-memory for its real lifetime (minus a safety margin)
// so repeated verification requests don't re-authenticate on every single call.
export async function getPayPalAccessToken(): Promise<string | null> {
  const clientId = process.env.PAYPAL_CLIENT_ID
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.accessToken

  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const json = await res.json() as { access_token?: string; expires_in?: number }
    if (!json.access_token) return null
    const ttlMs = Math.max(0, ((json.expires_in ?? 300) - 60) * 1000)
    cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + ttlMs }
    return json.access_token
  } catch {
    return null
  }
}

export type PayPalTransactionDetail = {
  transaction_info?: {
    transaction_id?: string
    transaction_status?: string // 'S' success | 'D' denied | 'P' pending | 'V' reversed
    transaction_amount?: { currency_code?: string; value?: string }
    transaction_initiation_date?: string
    transaction_updated_date?: string
    paypal_account_id?: string
  }
  payer_info?: {
    email_address?: string
    account_id?: string
  }
}

export type PayPalTransactionLookupResult =
  | { ok: true; transaction: PayPalTransactionDetail }
  | { ok: false; reason: 'not_configured' | 'auth_failed' | 'not_found' | 'request_failed' }

// Real call to PayPal's Transaction Search API (GET /v1/reporting/transactions). This endpoint is
// scoped to the AUTHENTICATED merchant account's own transaction history — it can only ever return
// transactions actually received by whichever PayPal business account PAYPAL_CLIENT_ID/SECRET
// belong to, which is what makes "this transaction was paid to us" verifiable at all (there's no
// separate raw "receiver email" field to check independently of that scoping).
//
// REQUIRES, DISCLOSED: the "Transaction Search" API product must be added to this REST app in the
// PayPal Developer Dashboard (App → Add Products → Transaction Search) — a plain REST app without
// it will get a 403 here. This is a real PayPal account/dashboard step, not something this code can
// configure on your behalf.
export async function lookupPayPalTransaction(transactionId: string): Promise<PayPalTransactionLookupResult> {
  const token = await getPayPalAccessToken()
  if (!token) return { ok: false, reason: process.env.PAYPAL_CLIENT_ID ? 'auth_failed' : 'not_configured' }

  // Transaction Search requires a start/end date window (max 31 days per request). Search the
  // widest safe window PayPal allows so a transaction from any time in the last 31 days resolves —
  // a real, disclosed limitation of this API (not this code): a transaction older than 31 days
  // cannot be found this way at all.
  const end = new Date()
  const start = new Date(end.getTime() - 31 * 24 * 60 * 60 * 1000)
  const params = new URLSearchParams({
    transaction_id: transactionId,
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    fields: 'transaction_info,payer_info',
  })

  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v1/reporting/transactions?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, reason: 'request_failed' }
    const json = await res.json() as { transaction_details?: PayPalTransactionDetail[] }
    const match = json.transaction_details?.find((t) => t.transaction_info?.transaction_id === transactionId)
    if (!match) return { ok: false, reason: 'not_found' }
    return { ok: true, transaction: match }
  } catch {
    return { ok: false, reason: 'request_failed' }
  }
}

// ── Recurring Subscriptions (Billing Plans / Subscriptions API) ─────────────────────────────────

export type CreateSubscriptionResult =
  | { ok: true; subscriptionId: string; approvalUrl: string }
  | { ok: false; reason: 'not_configured' | 'auth_failed' | 'request_failed' }

// Creates a real PayPal subscription against an existing Billing Plan (plan_id — configured in the
// PayPal Developer Dashboard, not created by this code). Returns the subscription id (stored as
// paypal_subscriptions.paypal_subscription_id) and the approval URL the browser must redirect to
// so the user can approve the subscription on PayPal's own site.
export async function createPayPalSubscription(
  planId: string,
  customId: string,
  returnUrl: string,
  cancelUrl: string,
): Promise<CreateSubscriptionResult> {
  const token = await getPayPalAccessToken()
  if (!token) return { ok: false, reason: process.env.PAYPAL_CLIENT_ID ? 'auth_failed' : 'not_configured' }

  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Idempotency key — a retry of the same request (e.g. a network blip) won't create a
        // second subscription on PayPal's side.
        'PayPal-Request-Id': `sub-${sanitizeCustomId(customId)}-${planId}`,
      },
      body: JSON.stringify({
        plan_id: planId,
        // Echoed back on every webhook event's resource.custom_id — this is how the webhook
        // handler ties a PayPal subscription event back to our own user id without trusting
        // anything the client sends at webhook time.
        custom_id: customId,
        application_context: {
          brand_name: 'ChainLens',
          user_action: 'SUBSCRIBE_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, reason: 'request_failed' }
    const json = await res.json() as { id?: string; links?: Array<{ rel?: string; href?: string }> }
    const approvalUrl = json.links?.find((l) => l.rel === 'approve')?.href
    if (!json.id || !approvalUrl) return { ok: false, reason: 'request_failed' }
    return { ok: true, subscriptionId: json.id, approvalUrl }
  } catch {
    return { ok: false, reason: 'request_failed' }
  }
}

function sanitizeCustomId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
}

export type PayPalWebhookSignatureHeaders = {
  transmissionId: string
  transmissionTime: string
  certUrl: string
  authAlgo: string
  transmissionSig: string
}

// Verifies a webhook actually came from PayPal via the official verify-webhook-signature API,
// rather than trusting the payload as-is — required before acting on any webhook event, since
// these events change billing state (grant/revoke Pro/Elite).
export async function verifyPayPalWebhookSignature(
  headers: PayPalWebhookSignatureHeaders,
  webhookId: string,
  body: unknown,
): Promise<boolean> {
  const token = await getPayPalAccessToken()
  if (!token) return false
  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transmission_id: headers.transmissionId,
        transmission_time: headers.transmissionTime,
        cert_url: headers.certUrl,
        auth_algo: headers.authAlgo,
        transmission_sig: headers.transmissionSig,
        webhook_id: webhookId,
        webhook_event: body,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return false
    const json = await res.json() as { verification_status?: string }
    return json.verification_status === 'SUCCESS'
  } catch {
    return false
  }
}
