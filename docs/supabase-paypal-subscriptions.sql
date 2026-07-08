-- PayPal recurring Subscriptions — real Orders/Subscriptions API integration, distinct from the
-- one-time static-link + manual transaction verification flow (docs/paypal-verification.md /
-- paypal_transactions). This one drives billing.plan_id-based recurring subscriptions created via
-- /api/paypal/create-subscription and reconciled by /api/paypal/webhook.
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
