-- ChainLens PayPal payments table
-- Run in Supabase SQL editor. Mirrors crypto_payments' own shape/RLS convention exactly
-- (see docs/supabase-rls-security.sql's crypto_payments section) — same "server-side only
-- writes, users may read their own rows" security model, different payment processor.
--
-- Required env vars (server-side only):
--   PAYPAL_CLIENT_ID       — REST app client id from developer.paypal.com
--   PAYPAL_CLIENT_SECRET   — REST app client secret
--   PAYPAL_WEBHOOK_ID      — webhook id from the PayPal app's Webhooks settings
--   PAYPAL_ENV             — 'live' or 'sandbox' (selects api-m.paypal.com vs .sandbox.)
--   SUPABASE_SERVICE_ROLE_KEY — used by checkout route + webhook handler

create table if not exists public.paypal_payments (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null,
  order_id           text        not null unique,       -- PayPal's own Order v2 id
  capture_id         text,                                -- set once PAYMENT.CAPTURE.COMPLETED fires
  user_email         text,
  plan               text        not null,
  amount_usd         numeric     not null,
  status             text        not null default 'created', -- created | completed
  referral_code      text,
  affiliate_id       uuid        references public.affiliates(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists paypal_payments_user_id_idx on public.paypal_payments(user_id);
create index if not exists paypal_payments_order_id_idx on public.paypal_payments(order_id);

alter table public.paypal_payments enable row level security;

drop policy if exists "Users can select own paypal payments" on public.paypal_payments;
drop policy if exists "paypal_payments_service_role_all" on public.paypal_payments;

-- Users may read their own payment rows only (useful for showing payment status on /pricing)
create policy "Users can select own paypal payments"
  on public.paypal_payments
  for select
  using (auth.uid() = user_id);

-- Service role has full access for checkout and webhook routes
create policy "paypal_payments_service_role_all"
  on public.paypal_payments
  for all
  to service_role
  using (true)
  with check (true);

-- No user insert/update/delete policies — all writes are server-side only (checkout route inserts,
-- webhook route updates on capture).
