// Server-only module — real PayPal REST API (OAuth2 + Subscriptions API). Never import from
// client components — PAYPAL_CLIENT_SECRET must never reach the browser.
//
// PayPal is integrated as a real recurring Subscriptions flow: createPayPalSubscription creates a
// subscription against a Billing Plan (plan_id) configured in the PayPal Developer Dashboard, the
// user approves it on PayPal's own site, and verifyPayPalWebhookSignature gates every webhook event
// at /api/paypal/webhook before it's allowed to change billing state. See
// docs/paypal-verification.md.
//
// REMOVED, DISCLOSED: this module previously also supported a one-time-payment flow (a static
// PayPal checkout link + manual transaction-ID entry, verified via the Transaction Search/Reporting
// API — lookupPayPalTransaction/PayPalTransactionDetail/PayPalTransactionLookupResult). That flow
// and its UI (PayPalVerifyScreen) and API route (/api/paypal/verify) have been deleted entirely per
// explicit instruction to replace manual verification with the Subscriptions flow below — not kept
// as a second, parallel PayPal integration.

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
    if (!res.ok) {
      // DIAGNOSTIC FIX, DISCLOSED: previously discarded PayPal's real error body entirely, so an
      // auth failure looked identical whether the cause was a bad client id/secret, a
      // sandbox/live env mismatch, an IP restriction on the REST app, or something else — pure
      // guesswork from the outside. Logging server-side only (never returned to the client, which
      // still only ever sees the generic 'auth_failed' reason) so the real PayPal error (e.g.
      // "invalid_client") is visible in server logs instead of silently swallowed.
      const bodyText = await res.text().catch(() => '<unreadable>')
      console.error(`[paypal] OAuth token request failed: ${res.status} ${res.statusText} — ${bodyText} (PAYPAL_ENV=${PAYPAL_ENV}, base=${PAYPAL_API_BASE})`)
      return null
    }
    const json = await res.json() as { access_token?: string; expires_in?: number }
    if (!json.access_token) return null
    const ttlMs = Math.max(0, ((json.expires_in ?? 300) - 60) * 1000)
    cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + ttlMs }
    return json.access_token
  } catch (err) {
    console.error('[paypal] OAuth token request threw:', err)
    return null
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
