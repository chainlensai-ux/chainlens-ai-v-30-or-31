# ChainLens Crypto Payments — NOWPayments

## Required Environment Variables

| Variable | Scope | Description |
|---|---|---|
| `NOWPAYMENTS_API_KEY` | Server only | NOWPayments API key from your dashboard |
| `NOWPAYMENTS_IPN_SECRET` | Server only | IPN secret from NOWPayments dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Supabase service role key — used by IPN handler to bypass RLS when activating plan |
| `NEXT_PUBLIC_APP_URL` | Public | Deployment URL: `https://chainlens-vthirty.vercel.app` |

**Never expose `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, or `SUPABASE_SERVICE_ROLE_KEY` to the client.**

---

## IPN (Webhook) URL

Register this URL in your NOWPayments dashboard:

```
https://chainlens-vthirty.vercel.app/api/webhooks/crypto
```

---

## Vercel Environment Variable Setup

1. Go to **Vercel → Project → Settings → Environment Variables**
2. Add each variable for **Production** (and Preview if needed):

```
NOWPAYMENTS_API_KEY        = your_api_key_here
NOWPAYMENTS_IPN_SECRET     = your_ipn_secret_here
SUPABASE_SERVICE_ROLE_KEY  = your_service_role_key_here
NEXT_PUBLIC_APP_URL        = https://chainlens-vthirty.vercel.app
```

3. Redeploy after adding variables.

---

## NOWPayments Dashboard Setup

1. Create or log in at https://nowpayments.io
2. Go to **Store Settings → API Keys** → copy your API key → set as `NOWPAYMENTS_API_KEY`
3. Go to **Store Settings → IPN Settings**:
   - Enable IPN
   - Set IPN callback URL: `https://chainlens-vthirty.vercel.app/api/webhooks/crypto`
   - Copy the IPN secret → set as `NOWPAYMENTS_IPN_SECRET`

---

## Payment Flow

```
User clicks "Pay with crypto"
  → POST /api/checkout/crypto { plan: "pro" | "elite" }
  → Bearer token verified (user must be signed in)
  → Creates NOWPayments invoice with:
      price_amount: 30 or 60
      price_currency: "usd"
      order_id: "cl_{plan}_{timestamp}_{userId_no_hyphens}"
      order_description: "ChainLens AI Pro" or "ChainLens AI Elite"
      ipn_callback_url, success_url, cancel_url
  → Returns { checkoutUrl } (invoice_url from NOWPayments)
  → Browser redirects to hosted payment page

User completes payment
  → NOWPayments sends POST /api/webhooks/crypto (IPN)
  → Signature verified: HMAC-SHA512 of alphabetically sorted JSON body
  → payment_status checked: "confirmed" or "finished" only
  → order_id parsed → userId + plan extracted
  → price_amount + price_currency validated against expected
  → user_settings.plan updated via service role (bypasses RLS)
  → subscription_status set to "active"
  → payment_id deduped in-process
```

---

## IPN Status Handling

| Status | Action |
|---|---|
| `confirmed` | Activates user plan |
| `finished` | Activates user plan |
| `waiting` | Ignored |
| `confirming` | Ignored |
| `sending` | Ignored |
| `partially_paid` | Ignored |
| `failed` | Ignored |
| `expired` | Ignored |
| `refunded` | Ignored |

---

## IPN Signature Verification

NOWPayments signs IPN callbacks using HMAC-SHA512:
1. Sort all top-level JSON keys alphabetically
2. Stringify the sorted object
3. Compute `HMAC-SHA512(sortedJson, NOWPAYMENTS_IPN_SECRET)`
4. Compare (constant-time) with `x-nowpayments-sig` header

Invalid signatures are rejected with HTTP 400.

---

## Fallback Behavior

| Condition | Behavior |
|---|---|
| `NOWPAYMENTS_API_KEY` not set | `POST /api/checkout/crypto` returns 503 + clean error shown on pricing page |
| `NOWPAYMENTS_IPN_SECRET` not set | IPN returns 200 (no activation) + server warning logged |
| `SUPABASE_SERVICE_ROLE_KEY` not set | IPN returns 500 → NOWPayments retries IPN |
| DB activation error | IPN returns 500 → NOWPayments retries IPN |
| Duplicate `payment_id` | IPN returns 200, activation skipped |
| Invalid signature | IPN returns 400 |

---

## Test Checklist

- [ ] Signed-out user clicks "Pay with crypto" → error: "Sign in to start checkout."
- [ ] Signed-in free user starts Pro checkout → redirected to NOWPayments hosted page
- [ ] Signed-in free user starts Elite checkout → redirected to NOWPayments hosted page
- [ ] Missing `NOWPAYMENTS_API_KEY` → pricing page shows "Crypto checkout is not configured yet."
- [ ] IPN with wrong signature → HTTP 400, plan NOT activated
- [ ] IPN with status `confirming` → HTTP 200, plan NOT activated
- [ ] IPN with status `confirmed`, valid payload → plan activated in Supabase
- [ ] IPN with status `finished`, valid payload → plan activated in Supabase
- [ ] Duplicate IPN (same `payment_id`) → HTTP 200, second activation skipped
- [ ] Pricing page shows "Current plan" on Pro card after Pro activation
- [ ] Pricing page shows "Current plan" on Elite card after Elite activation

---

## Multi-Instance Note

The in-process deduplication set (`processedPaymentIds`) is per-process.
For deployments with multiple server instances, replace with a DB-backed
idempotency check against a `crypto_payments` table.
