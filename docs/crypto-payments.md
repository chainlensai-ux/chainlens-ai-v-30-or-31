# ChainLens Crypto Payments

## Required Environment Variables

| Variable | Scope | Description |
|---|---|---|
| `COINBASE_COMMERCE_API_KEY` | Server only | Coinbase Commerce API key |
| `COINBASE_COMMERCE_WEBHOOK_SECRET` | Server only | Webhook shared secret from Coinbase Commerce dashboard |
| `NEXT_PUBLIC_APP_URL` | Public | Your deployment URL, e.g. `https://chainlens.ai` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Supabase service role key — used by webhook to bypass RLS when activating plan |

**Never expose `COINBASE_COMMERCE_API_KEY`, `COINBASE_COMMERCE_WEBHOOK_SECRET`, or `SUPABASE_SERVICE_ROLE_KEY` to the client.**

---

## Webhook URL

Register this URL in your Coinbase Commerce dashboard:

```
https://YOUR_DOMAIN.com/api/webhooks/crypto
```

---

## Coinbase Commerce Dashboard Setup

1. Create or log in at https://commerce.coinbase.com
2. Go to **Settings → API Keys** → create a new API key
   - Copy the key → set as `COINBASE_COMMERCE_API_KEY`
3. Go to **Settings → Webhook subscriptions** → Add endpoint
   - URL: `https://YOUR_DOMAIN.com/api/webhooks/crypto`
   - Copy the shared secret → set as `COINBASE_COMMERCE_WEBHOOK_SECRET`

---

## Payment Flow

```
User clicks "Pay with crypto"
  → POST /api/checkout/crypto { plan }
  → Verifies bearer token (user must be signed in)
  → Creates Coinbase Commerce charge with metadata { userId, email, plan, amountUsd }
  → Returns { checkoutUrl }
  → Browser redirects to hosted checkout page

User completes payment
  → Coinbase Commerce sends POST /api/webhooks/crypto
  → Signature verified (HMAC-SHA256)
  → Event type checked (charge:confirmed or charge:resolved only)
  → metadata.userId + metadata.plan extracted
  → Amount validated against expected (pro=$30, elite=$60)
  → user_settings.plan updated via service role (bypasses RLS)
  → plan_status set to "active"
```

---

## Events Handled

| Event | Action |
|---|---|
| `charge:confirmed` | Activates user plan |
| `charge:resolved` | Activates user plan |
| `charge:pending` | Ignored |
| `charge:failed` | Ignored |
| `charge:expired` | Ignored |

---

## Fallback Behavior

If `COINBASE_COMMERCE_API_KEY` is not set:
- `POST /api/checkout/crypto` returns HTTP 503 with `{ error: "Crypto checkout is not configured yet." }`
- Pricing page shows the error inline — no crash

If `COINBASE_COMMERCE_WEBHOOK_SECRET` is not set:
- Webhook route acknowledges with HTTP 200 (to avoid provider retries) and logs a warning

If `SUPABASE_SERVICE_ROLE_KEY` is not set:
- Webhook returns HTTP 500 → provider will retry
- Plan is NOT activated until the key is configured

---

## Test Checklist

- [ ] Signed-out user clicks "Pay with crypto" → error: "Sign in to start checkout."
- [ ] Signed-in free user can start Pro checkout → redirected to Coinbase Commerce
- [ ] Signed-in free user can start Elite checkout → redirected to Coinbase Commerce
- [ ] Missing `COINBASE_COMMERCE_API_KEY` → clean error shown on pricing page
- [ ] Webhook with invalid signature → HTTP 400, plan NOT activated
- [ ] Webhook `charge:pending` event → HTTP 200, plan NOT activated
- [ ] Webhook `charge:confirmed` event with valid payload → plan activated in Supabase
- [ ] Duplicate webhook event (same `id`) → HTTP 200, second activation skipped
- [ ] Pricing page reflects updated plan after next page load

---

## Multi-Instance Note

The in-process deduplication set (`processedEventIds`) is per-process.  
For deployments with multiple server instances, replace with a DB-backed idempotency key check against a `crypto_payments` table (see `docs/supabase-subscriptions.sql` for reference schema).
