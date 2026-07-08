# PayPal payments — static link + manual transaction verification

ChainLens offers PayPal as a second payment option next to crypto (NowPayments). Unlike crypto,
this does **not** use PayPal's Orders v2 API or a webhook. It uses a pre-existing static PayPal
Native Checkout Page link plus a manual "paste your transaction ID back" verification step, because
the checkout link itself carries no per-app metadata and has no webhook attached to it.

## Flow

1. User clicks "Card" on `/pricing` (`handleCardPay` in `app/pricing/page.tsx`). If they're not
   signed in, they're redirected to auth first — PayPal verification requires an authenticated
   session (see "Why Bearer-derived userId" below).
2. The static PayPal link (`https://www.paypal.com/ncp/payment/LA29DL2QZQSL`) opens in a new tab.
   The user pays there, on PayPal's own hosted page.
3. Back on `/pricing`, `<PayPalVerifyScreen />` is shown. The user copies the Transaction ID from
   their PayPal receipt/email and pastes it in, then clicks "Verify Payment".
4. That calls `POST /api/paypal/verify` with `{ transactionId, plan }` and the user's Supabase
   session Bearer token.
5. The route (`app/api/paypal/verify/route.ts`):
   - Rate-limits the request.
   - Derives `userId` from the authenticated session — **not** from any client-supplied field.
   - Rejects malformed transaction IDs before calling out to PayPal.
   - Checks `paypal_transactions` for an existing row with that `transaction_id`: if it already
     belongs to this same user, returns success idempotently (e.g. the user double-clicked or
     retried); if it belongs to a *different* user, rejects with a conflict (prevents transaction-ID
     reuse across accounts).
   - Calls `lookupPayPalTransaction()` (`lib/paypal.ts`), which gets an OAuth2 token via
     client-credentials and calls PayPal's Transaction Search / Reporting API:
     `GET /v1/reporting/transactions?transaction_id=...`. This endpoint is scoped to whichever
     PayPal business account owns `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` — it can only ever
     return a transaction that was actually paid *to that account*, which is what makes "this was
     really paid to us" verifiable without a separate receiver-email field.
   - Validates the transaction:
     - `transaction_status === 'S'` (PayPal's real status codes are single letters — `S` success,
       `D` denied, `P` pending, `V` reversed — not the string `"COMPLETED"`).
     - A payer email is present on the transaction.
     - Currency and amount match the plan's expected price (`PAYPAL_EXPECTED_CURRENCY`,
       `PAYPAL_PRO_PRICE`/`PAYPAL_ELITE_PRICE`, with a small tolerance for PayPal fee rounding).
   - On success: calls `activateUserPlanServerSide(userId, plan, transactionId)` — the exact same
     function the crypto payment flow uses — then inserts a row into `paypal_transactions`.
   - Returns `{ success: true, plan }`, and the UI updates the user's plan immediately.
6. `/terminal/settings` reads `effectivePlan` from `/api/user-settings` and shows a "Current Plan"
   badge (Free / Pro / Elite) with an upgrade link when on Free.

## Setup required (PayPal Developer Dashboard)

The "Transaction Search" product must be added to your PayPal REST app (App → Add Products →
Transaction Search). A plain REST app without it gets a 403 from the Reporting API.

## Disclosed deviations from a literal "COMPLETED status, client-supplied userId" spec

- **userId comes from the Bearer session token, never from the request body.** Trusting a
  client-supplied `userId` would let anyone upgrade an arbitrary account by guessing/copying its ID.
- **Status check is `'S'`, not `"COMPLETED"`.** PayPal's real Reporting API returns single-letter
  status codes; there is no `"COMPLETED"` value to check for.
- **Pricing defaults to the app's real $30/$60 USD**, not an example price — configurable via
  `PAYPAL_PRO_PRICE`, `PAYPAL_ELITE_PRICE`, `PAYPAL_EXPECTED_CURRENCY` in case the PayPal link is
  ever priced differently.
- **A 31-day search window**, PayPal's maximum for the Reporting API — a transaction older than 31
  days cannot be verified this way at all; this is a PayPal API limit, not something this code
  can work around.

## Database

See `docs/supabase-paypal-transactions.sql` for the `paypal_transactions` table (unique
`transaction_id` constraint enforces one-time use per transaction) and its RLS policies.
