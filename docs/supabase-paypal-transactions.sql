-- ChainLens PayPal transaction verification table
-- Run in Supabase SQL editor.
--
-- ARCHITECTURE, DISCLOSED: this backs the manual "paste your PayPal transaction ID" verification
-- flow (POST /api/paypal/verify), not an Orders-API/webhook flow — see docs/paypal-verification.md
-- for the full setup + flow explanation.
--
-- Required env vars (server-side only):
--   PAYPAL_CLIENT_ID       — REST app Client ID from developer.paypal.com
--   PAYPAL_CLIENT_SECRET   — REST app Client Secret
--   PAYPAL_ENV             — 'live' or 'sandbox'
--   PAYPAL_PRO_PRICE       — expected Pro price (e.g. "30.00")
--   PAYPAL_PRO_CURRENCY    — expected currency code (e.g. "USD")
--   SUPABASE_SERVICE_ROLE_KEY — used by the verify route to bypass RLS

create table if not exists public.paypal_transactions (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null,
  method            text        not null default 'paypal',
  transaction_id    text        not null unique,   -- UNIQUE: the same real transaction can only ever grant a plan once
  payer_email       text,
  amount            numeric     not null,
  currency          text        not null,
  plan              text        not null,
  status             text       not null default 'completed',
  created_at        timestamptz not null default now()
);

create index if not exists paypal_transactions_user_id_idx on public.paypal_transactions(user_id);

alter table public.paypal_transactions enable row level security;

drop policy if exists "Users can select own paypal transactions" on public.paypal_transactions;
drop policy if exists "paypal_transactions_service_role_all" on public.paypal_transactions;

-- Users may read their own transaction rows only
create policy "Users can select own paypal transactions"
  on public.paypal_transactions
  for select
  using (auth.uid() = user_id);

-- Service role has full access — all writes come from the server-side verify route
create policy "paypal_transactions_service_role_all"
  on public.paypal_transactions
  for all
  to service_role
  using (true)
  with check (true);

-- No user insert/update/delete policies — every row is written server-side only, after PayPal's
-- own Reporting API has confirmed the transaction is real, COMPLETED, and for the right amount.
