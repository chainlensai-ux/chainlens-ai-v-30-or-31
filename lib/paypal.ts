// Server-only module — real PayPal REST API (Orders v2 + webhook signature verification).
// Never import from client components — PAYPAL_CLIENT_SECRET must never reach the browser.
//
// REPLACES LemonSqueezy, DISCLOSED: this codebase previously had a LemonSqueezy webhook
// (app/api/webhooks/lemonsqueezy/route.ts) that was never actually wired to a checkout-creation
// route or a frontend button — real, working plan-activation logic with nothing that could ever
// trigger it. Deleted per explicit instruction in favor of a genuine, complete PayPal integration
// (checkout creation + signature-verified webhook), mirroring the same real, working pattern
// app/api/checkout/crypto + app/api/webhooks/crypto already use for NOWPayments.

const PAYPAL_ENV = (process.env.PAYPAL_ENV ?? 'sandbox').toLowerCase()
export const PAYPAL_API_BASE = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'

let cachedToken: { accessToken: string; expiresAt: number } | null = null

// OAuth2 client-credentials token, cached in-memory for its real lifetime (minus a safety margin)
// so a burst of checkout/webhook requests doesn't re-authenticate on every single call — the same
// "don't waste a real network call when we already have a valid answer" reasoning used everywhere
// else in this codebase this session (basedex.ts, goldrushPriceSource.ts).
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
    // Subtract a 60s safety margin so we never use a token that expires mid-request.
    const ttlMs = Math.max(0, ((json.expires_in ?? 300) - 60) * 1000)
    cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + ttlMs }
    return json.access_token
  } catch {
    return null
  }
}

export type PayPalOrder = {
  id: string
  status: string
  links?: Array<{ href: string; rel: string; method: string }>
}

// Creates a real PayPal Order (Orders v2 API, intent=CAPTURE). The caller (checkout route) is
// responsible for persisting a DB row keyed by the returned order id BEFORE trusting anything the
// webhook later reports — same "never trust the webhook payload alone" principle the crypto
// webhook already uses (it requires a matching crypto_payments row to exist).
export async function createPayPalOrder(params: {
  amountUsd: number
  customId: string
  description: string
  returnUrl: string
  cancelUrl: string
}): Promise<PayPalOrder | null> {
  const token = await getPayPalAccessToken()
  if (!token) return null

  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          custom_id: params.customId,
          description: params.description,
          amount: { currency_code: 'USD', value: params.amountUsd.toFixed(2) },
        }],
        application_context: {
          brand_name: 'ChainLens AI',
          user_action: 'PAY_NOW',
          return_url: params.returnUrl,
          cancel_url: params.cancelUrl,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return await res.json() as PayPalOrder
  } catch {
    return null
  }
}

// Captures an approved order — called by the webhook handler on CHECKOUT.ORDER.APPROVED, since a
// server-redirect flow (no client-side JS SDK button) requires an explicit server-initiated
// capture call; PayPal does not auto-capture on approval by itself in this flow.
export async function capturePayPalOrder(orderId: string): Promise<{ ok: boolean; status?: string }> {
  const token = await getPayPalAccessToken()
  if (!token) return { ok: false }

  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    // 422 UNPROCESSABLE_ENTITY with ORDER_ALREADY_CAPTURED is expected on a webhook retry —
    // treat it as success rather than an error, since the capture genuinely already happened.
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { details?: Array<{ issue?: string }> } | null
      const alreadyCaptured = body?.details?.some((d) => d.issue === 'ORDER_ALREADY_CAPTURED')
      return { ok: Boolean(alreadyCaptured) }
    }
    const json = await res.json() as { status?: string }
    return { ok: true, status: json.status }
  } catch {
    return { ok: false }
  }
}

// Real signature verification via PayPal's own verify-webhook-signature API — the only trustworthy
// way to confirm a webhook POST actually came from PayPal (mirrors the crypto webhook's HMAC
// verification, but PayPal's scheme requires calling back to their API with the transmission
// headers rather than computing a local HMAC).
export async function verifyPayPalWebhookSignature(params: {
  transmissionId: string
  transmissionTime: string
  certUrl: string
  authAlgo: string
  transmissionSig: string
  webhookId: string
  rawBody: string
}): Promise<boolean> {
  const token = await getPayPalAccessToken()
  if (!token) return false

  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transmission_id: params.transmissionId,
        transmission_time: params.transmissionTime,
        cert_url: params.certUrl,
        auth_algo: params.authAlgo,
        transmission_sig: params.transmissionSig,
        webhook_id: params.webhookId,
        webhook_event: JSON.parse(params.rawBody),
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
