# ChainLens Card Payments — PayPal

Replaces the previous, never-finished LemonSqueezy integration (a webhook handler existed with
real plan-activation logic, but nothing ever generated a checkout URL or called it — deleted along
with this build). This is a complete, connected integration: checkout creation, real PayPal Orders
v2 API, and a signature-verified webhook that activates the plan exactly like the crypto flow does.

## Required Environment Variables

| Variable | Scope | Description |
|---|---|---|
| `PAYPAL_CLIENT_ID` | Server only | REST app Client ID from developer.paypal.com |
| `PAYPAL_CLIENT_SECRET` | Server only | REST app Client Secret |
| `PAYPAL_WEBHOOK_ID` | Server only | Webhook ID from the app's Webhooks settings |
| `PAYPAL_ENV` | Server only | `live` or `sandbox` — selects `api-m.paypal.com` vs `api-m.sandbox.paypal.com` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Used by checkout route + webhook handler to bypass RLS |
| `NEXT_PUBLIC_APP_URL` | Public | Deployment URL, used for return/cancel redirect URLs |

**Never expose `PAYPAL_CLIENT_SECRET` or `SUPABASE_SERVICE_ROLE_KEY` to the client.**

---

## PayPal Developer Setup

1. Go to https://developer.paypal.com/dashboard/applications and create a REST app (or use an
   existing one) under the correct environment (Sandbox for testing, Live for production).
2. Copy the app's **Client ID** and **Client Secret** → set as `PAYPAL_CLIENT_ID` /
   `PAYPAL_CLIENT_SECRET`.
3. In the same app, go to **Webhooks** → **Add Webhook**:
   - Webhook URL: `https://<your-deployment>/api/webhooks/paypal`
   - Subscribe to these event types (only these two are handled — anything else is safely ignored):
     - `CHECKOUT.ORDER.APPROVED`
     - `PAYMENT.CAPTURE.COMPLETED`
   - Copy the generated **Webhook ID** → set as `PAYPAL_WEBHOOK_ID`.
4. Set `PAYPAL_ENV=sandbox` while testing, `PAYPAL_ENV=live` once you switch to a Live app's
   credentials (sandbox and live credentials/webhook IDs are entirely separate — don't mix them).

---

## Database Setup

Run `docs/supabase-paypal-payments.sql` in the Supabase SQL editor. Creates the `paypal_payments`
table (mirrors `crypto_payments`' own shape and RLS policy exactly).

---

## Payment Flow

```
User clicks the "Card" box on a Pro/Elite plan
  → POST /api/checkout/paypal { plan: "pro" | "elite" }
  → Bearer token verified (user must be signed in)
  → Creates a real PayPal Order (Orders v2, intent=CAPTURE):
      amount: 30.00 or 60.00 USD
      custom_id: "cl_{plan}_{timestamp}_{userId_no_hyphens}"
      return_url / cancel_url → /pricing?payment=success|cancelled
  → Inserts a paypal_payments row (status: "created") keyed by PayPal's own order id
  → Returns { checkoutUrl } (the order's "approve" link)
  → Browser redirects to PayPal's hosted approval page

User approves the payment on PayPal
  → PayPal sends CHECKOUT.ORDER.APPROVED to /api/webhooks/paypal
  → Signature verified via PayPal's own verify-webhook-signature API
  → Server calls PayPal's capture endpoint for that order
    (a server-redirect flow, unlike the JS SDK's Smart Buttons, does not auto-capture on approval)

PayPal sends PAYMENT.CAPTURE.COMPLETED
  → Signature verified again (every webhook POST is verified independently)
  → custom_id parsed → userId + plan extracted (never trusted alone)
  → amount + currency validated against the expected plan price
  → Matching paypal_payments row (by order id) required to exist — activation is REFUSED
    without one, exactly like crypto's webhook requires a matching crypto_payments row
  → user_settings.plan updated via service role (bypasses RLS) — same
    activateUserPlanServerSide() call the crypto webhook uses, so a PayPal purchase grants the
    exact same plan/features as a crypto purchase, nothing more or less
  → subscription_status set to "active"
  → capture_id deduped in-process (a webhook retry never double-activates or double-pays a
    referral commission)
  → affiliate commission recorded, same logic as the crypto webhook
```

---

## Signature Verification

PayPal's webhook signature scheme is a callback to their own verification API (unlike crypto's
local HMAC computation) — every POST includes `paypal-transmission-id`, `paypal-transmission-time`,
`paypal-cert-url`, `paypal-auth-algo`, and `paypal-transmission-sig` headers, which are sent along
with the webhook ID and raw event body to `POST /v1/notifications/verify-webhook-signature`. Only a
`verification_status: "SUCCESS"` response is trusted; anything else returns HTTP 400.

---

## Fallback Behavior

| Condition | Behavior |
|---|---|
| `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` not set | `POST /api/checkout/paypal` returns 503 + clean error shown on pricing page |
| `PAYPAL_WEBHOOK_ID` not set | Webhook returns HTTP 500 (never silently skips verification) |
| Invalid webhook signature | Webhook returns HTTP 400, nothing activated |
| No matching `paypal_payments` row | Webhook returns HTTP 200, activation skipped (never trusts the payload alone) |
| Duplicate `capture_id` (webhook retry) | Webhook returns HTTP 200, activation skipped |
| `SUPABASE_SERVICE_ROLE_KEY` not set | Activation fails, webhook returns HTTP 500 → PayPal retries |

---

## Test Checklist

- [ ] Signed-out user clicks "Card" → error: "Sign in to start checkout."
- [ ] Signed-in free user starts Pro checkout via Card → redirected to PayPal's hosted approval page
- [ ] Signed-in free user starts Elite checkout via Card → redirected to PayPal's hosted approval page
- [ ] Missing `PAYPAL_CLIENT_ID`/`SECRET` → pricing page shows "Card checkout is not configured yet."
- [ ] Webhook with wrong/missing signature → HTTP 400, plan NOT activated
- [ ] `CHECKOUT.ORDER.APPROVED` → order captured server-side (check PayPal dashboard)
- [ ] `PAYMENT.CAPTURE.COMPLETED` with valid payload → plan activated in Supabase
- [ ] Duplicate `PAYMENT.CAPTURE.COMPLETED` (same capture id) → second activation skipped
- [ ] Pricing page shows "Current plan" on Pro card after Pro activation via Card
- [ ] Pricing page shows "Current plan" on Elite card after Elite activation via Card
