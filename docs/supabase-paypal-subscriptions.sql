-- PayPal recurring Subscriptions — real Subscriptions API integration. Drives billing.plan_id-based
-- recurring subscriptions created via /api/paypal/create-subscription and reconciled by
-- /api/paypal/webhook. This is the ONLY PayPal payment flow in this app — the earlier one-time
-- static-link + manual transaction-ID verification flow has been removed entirely (its
-- paypal_transactions table is no longer written to by any code path; drop it if you don't need
-- the historical rows).
--
-- This project has no Prisma/PostgreSQL layer — everything lives in Supabase — so this ports the
-- originally-requested Prisma "Subscription" model onto a Supabase table + RLS instead of adding a
-- second ORM/DB layer alongside Supabase.

create table if not exists public.paypal_subscriptions (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null references auth.users(id) on delete cascade,
  paypal_subscription_id text        not null unique,
  plan                   text        not null, -- 'pro' | 'elite' — which ChainLens plan this subscription grants
  status                 text        not null default 'pending', -- 'pending' | 'active' | 'cancelled'
  next_billing_date      timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists paypal_subscriptions_user_id_idx on public.paypal_subscriptions(user_id);

alter table public.paypal_subscriptions enable row level security;

-- Users can read their own subscription rows.
create policy "paypal_subscriptions_select_own"
  on public.paypal_subscriptions for select
  using (auth.uid() = user_id);

-- Only the service role (webhook handler, create-subscription route) writes to this table —
-- never the browser client directly.
create policy "paypal_subscriptions_service_role_all"
  on public.paypal_subscriptions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- REPLAY-PROTECTION FIX, DISCLOSED: signature verification proves a webhook event came from
-- PayPal, but PayPal redelivers the same event on retries/timeouts/manual dashboard resends —
-- without recording which event ids have already been processed, a redelivered event is
-- indistinguishable from a new one. Today every webhook branch happens to be idempotent by
-- accident (upserts keyed on paypal_subscription_id), but that's fragile; this table makes
-- duplicate-delivery detection explicit and enforced by a real unique constraint instead of
-- relying on every future branch staying accidentally idempotent forever.
create table if not exists public.paypal_webhook_events (
  event_id   text        primary key,
  event_type text        not null,
  received_at timestamptz not null default now()
);

alter table public.paypal_webhook_events enable row level security;

create policy "paypal_webhook_events_service_role_all"
  on public.paypal_webhook_events for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
