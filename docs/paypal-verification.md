# PayPal payments — recurring Subscriptions

ChainLens offers PayPal as a second payment option next to crypto (NowPayments), as a real
recurring **PayPal Subscriptions** integration — full Subscriptions API + signature-verified
webhook. This is the only PayPal payment flow in the app.

**REMOVED, DISCLOSED:** an earlier one-time-payment flow (a static PayPal checkout link + manual
"paste your transaction ID" entry, verified via the Transaction Search/Reporting API) has been
deleted entirely — its UI (`PayPalVerifyScreen`), API route (`/api/paypal/verify`), and the
`lookupPayPalTransaction` code in `lib/paypal.ts` are all gone, per explicit instruction to replace
manual verification with the Subscriptions flow below rather than keep both. The `paypal_transactions`
table (`docs/supabase-paypal-transactions.sql`) is no longer written to by anything; drop it if you
don't need the historical rows.

## Flow

1. User clicks "PayPal" on `/pricing` (`handlePayPalPay` in `app/pricing/page.tsx`). If they're not
   signed in, they're redirected to auth first.
2. The frontend calls `POST /api/paypal/create-subscription` with the user's Supabase session
   Bearer token and `{ plan: 'pro' | 'elite' }`.
3. The route (`app/api/paypal/create-subscription/route.ts`):
   - Rate-limits the request, derives `userId` from the authenticated session (never trusts a
     client-supplied user id).
   - Looks up the real PayPal Billing Plan id for the requested plan from
     `PAYPAL_PRO_PLAN_ID`/`PAYPAL_ELITE_PLAN_ID` — 503s with a clear error if not configured.
   - Blocks creating a second subscription if the user already has a `pending` or `active` one on
     file, so a double-click (or subscribing again while already subscribed) can't leave the user
     with two live PayPal subscriptions both actually charging them while this app only tracks one.
   - Calls `createPayPalSubscription()` (`lib/paypal.ts`), which does the real
     `POST /v1/billing/subscriptions` call, tagging the subscription with
     `custom_id = "<plan>:<userId>"` — this is how later webhook events get attributed back to the
     right ChainLens account without trusting anything the client sends.
   - Returns `{ approvalUrl, subscriptionId }`.
4. The frontend redirects the browser to `approvalUrl` — PayPal's own hosted approval page.
5. The user approves the subscription on PayPal's site, then is redirected back to
   `/pricing?paypal_subscription=approved`.
6. PayPal fires webhook events at `POST /api/paypal/webhook`. Every event is:
   - Verified for a real PayPal signature (`verifyPayPalWebhookSignature`, PayPal's own
     `verify-webhook-signature` API) before anything else happens.
   - Checked against `paypal_webhook_events` (unique on PayPal's own event id) — a redelivered
     event (PayPal retries on timeout/non-2xx) is detected and skipped rather than reprocessed.
   - For `BILLING.SUBSCRIPTION.CREATED`/`ACTIVATED`, cross-checked: the event's own `resource.plan_id`
     must match the plan its `custom_id` claims (via `PAYPAL_PRO_PLAN_ID`/`PAYPAL_ELITE_PLAN_ID`) —
     defense-in-depth against a subscription created outside this app's own route with a
     mismatched/forged `custom_id`.

   Event handling:
   - `BILLING.SUBSCRIPTION.CREATED` — inserts a `pending` row into `paypal_subscriptions`.
   - `BILLING.SUBSCRIPTION.ACTIVATED` — sets `plan`/`effectivePlan` to pro/elite via
     `activateUserPlanServerSide()` (the exact same function the crypto payment flow uses), and
     updates `paypal_subscriptions.status = 'active'` + `next_billing_date`.
   - `PAYMENT.SALE.COMPLETED` (recurring renewal charges) — looks up the subscription by
     `billing_agreement_id` and re-activates the plan, keeping it current on each billing cycle.
   - `BILLING.SUBSCRIPTION.CANCELLED` — marks the subscription row `cancelled`, and downgrades the
     user to free **only if** this subscription was the actual source of their paid plan (checked
     against the stored payment reference) — so cancelling a subscription never downgrades a user
     who separately paid via crypto.
7. Back on `/pricing`, since the plan isn't granted until the webhook lands (a few seconds after
   redirect), the page polls `/api/user-settings` for up to ~24s after returning from
   `?paypal_subscription=approved`, showing "activating your plan…" until it sees the real plan
   change (or gives up quietly if the webhook is unusually slow — the plan will still show correctly
   on the next page load once it lands).
8. `/terminal/settings` reads `effectivePlan` from `/api/user-settings` and shows a "Current Plan"
   badge (Free / Pro / Elite) plus, when an active PayPal subscription exists, its next billing date.

## Setup required (PayPal Developer Dashboard)

- Two Billing Plans, one per paid tier, with their ids in `PAYPAL_PRO_PLAN_ID`/`PAYPAL_ELITE_PLAN_ID`.
- A webhook pointed at `/api/paypal/webhook` on whichever domain is live (preview:
  `https://chainlens-vthirty.vercel.app`, production: `https://www.chainlensai.app`), subscribed to
  `BILLING.SUBSCRIPTION.CREATED`, `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`,
  `PAYMENT.SALE.COMPLETED`, with its Webhook ID in `PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID`.
- `docs/supabase-paypal-subscriptions.sql` — the `paypal_subscriptions` and `paypal_webhook_events`
  tables + RLS.

## Environment variables

```
PAYPAL_CLIENT_ID=<paypal-rest-app-client-id>
PAYPAL_CLIENT_SECRET=<paypal-rest-app-client-secret>
PAYPAL_ENV=live               # or 'sandbox' for testing — selects api-m.paypal.com vs api-m.sandbox.paypal.com
PAYPAL_PRO_PLAN_ID=<paypal-billing-plan-id-for-pro>
PAYPAL_ELITE_PLAN_ID=<paypal-billing-plan-id-for-elite>
PAYPAL_SUBSCRIPTIONS_WEBHOOK_ID=<paypal-webhook-id>
```

## Disclosed deviations

- **userId comes from the Bearer session token, never from the request body.** Trusting a
  client-supplied `userId` would let anyone upgrade an arbitrary account by guessing/copying its id.
- **`effectivePlan` stays computed**, not a stored `User.effectivePlan` column — via the existing
  `resolveEffectivePlan()` (a trial-aware plan resolver already used everywhere else in the app) —
  to avoid a second source of truth that could drift from it.
- No Prisma/PostgreSQL layer — this app uses Supabase everywhere, so the requested `Subscription`
  model is the `paypal_subscriptions` table, not a Prisma model.

## Database

See `docs/supabase-paypal-subscriptions.sql` for the `paypal_subscriptions` table (subscription
state, keyed on PayPal's own subscription id) and the `paypal_webhook_events` table (webhook
replay-protection, keyed on PayPal's own event id) + their RLS policies.
