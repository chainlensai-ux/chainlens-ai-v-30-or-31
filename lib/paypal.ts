// Server-only module — real PayPal REST API (OAuth2 + Transaction Search / Reporting API).
// Never import from client components — PAYPAL_CLIENT_SECRET must never reach the browser.
//
// ARCHITECTURE, DISCLOSED: this uses a STATIC, pre-existing PayPal payment link (Native Checkout
// Page) plus manual transaction-ID verification via the Reporting API — not the Orders v2 +
// webhook flow. The user pays via the static link (which carries no per-app metadata and has no
// webhook tied to it), then pastes their transaction ID back into the app, which looks that exact
// transaction up on PayPal's own servers and verifies it before granting the plan. This replaces
// an earlier Orders v2 + webhook implementation built in this same session — deleted rather than
// left running alongside this one, since maintaining two different, conflicting PayPal
// integrations in the same app would be worse than either alone.

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
