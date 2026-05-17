-- ============================================================
-- ChainLens AI — Affiliate + Payments Schema
-- v2: extends original with new columns, corrected defaults.
-- Run in Supabase SQL Editor.
-- Safe to re-run: CREATE uses IF NOT EXISTS, ALTER uses IF EXISTS guards.
-- ============================================================

create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────
-- affiliates
-- ────────────────────────────────────────────────────────────
create table if not exists public.affiliates (
  id             uuid        primary key default gen_random_uuid(),
  name           text,
  email          text,
  x_handle       text,
  telegram       text,
  audience_size  text,
  promotion_plan text,
  payout_wallet  text,
  referral_code  text        unique not null,
  status         text        not null default 'pending',
  commission_rate numeric    not null default 0.20,
  approved_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- Back-fill approved_at column for installs that ran v1
alter table public.affiliates add column if not exists approved_at timestamptz;
-- Correct the commission rate default from the old 0.30
alter table public.affiliates alter column commission_rate set default 0.20;

-- ────────────────────────────────────────────────────────────
-- crypto_payments
-- ────────────────────────────────────────────────────────────
create table if not exists public.crypto_payments (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null,
  order_id     text        unique not null,
  payment_id   text        unique,
  user_email   text,
  plan         text        not null,
  amount_usd   numeric     not null,
  status       text        not null default 'created',
  raw_status   text,
  referral_code text,
  affiliate_id uuid        references public.affiliates(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Back-fill new columns for installs that ran v1
alter table public.crypto_payments add column if not exists user_email  text;
alter table public.crypto_payments add column if not exists raw_status  text;
alter table public.crypto_payments add column if not exists updated_at  timestamptz not null default now();
-- payment_id should be unique (nullable)
do $$ begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename  = 'crypto_payments'
      and indexname  = 'crypto_payments_payment_id_uidx'
  ) then
    create unique index crypto_payments_payment_id_uidx
      on public.crypto_payments(payment_id)
      where payment_id is not null;
  end if;
end $$;

-- ────────────────────────────────────────────────────────────
-- affiliate_commissions
-- ────────────────────────────────────────────────────────────
create table if not exists public.affiliate_commissions (
  id                    uuid        primary key default gen_random_uuid(),
  affiliate_id          uuid        references public.affiliates(id) on delete set null,
  crypto_payment_id     uuid        references public.crypto_payments(id) on delete set null,
  buyer_user_id         uuid,
  buyer_email           text,
  payment_id            text        not null,
  referral_code         text        not null,
  plan                  text        not null,
  payment_amount_usd    numeric     not null,
  commission_rate       numeric     not null default 0.20,
  commission_amount     numeric     not null,
  status                text        not null default 'pending',
  paid_at               timestamptz,
  created_at            timestamptz not null default now()
);

-- Back-fill new columns for installs that ran v1
alter table public.affiliate_commissions add column if not exists crypto_payment_id  uuid references public.crypto_payments(id) on delete set null;
alter table public.affiliate_commissions add column if not exists buyer_email         text;
alter table public.affiliate_commissions add column if not exists paid_at             timestamptz;
-- Correct old 0.30 default
alter table public.affiliate_commissions alter column commission_rate set default 0.20;

-- Rename payment_amount -> payment_amount_usd (idempotent)
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'affiliate_commissions'
      and column_name  = 'payment_amount'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'affiliate_commissions'
      and column_name  = 'payment_amount_usd'
  ) then
    alter table public.affiliate_commissions
      rename column payment_amount to payment_amount_usd;
  end if;
end $$;

-- Add payment_amount_usd if truly absent (fresh install guard)
alter table public.affiliate_commissions
  add column if not exists payment_amount_usd numeric;

-- ────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────
create unique index if not exists affiliate_commissions_payment_id_uidx
  on public.affiliate_commissions(payment_id)
  where payment_id is not null;

create index if not exists affiliates_referral_code_idx on public.affiliates(referral_code);
create index if not exists affiliates_status_idx        on public.affiliates(status);
create index if not exists crypto_payments_order_id_idx on public.crypto_payments(order_id);
create index if not exists crypto_payments_affiliate_idx on public.crypto_payments(affiliate_id) where affiliate_id is not null;

-- ────────────────────────────────────────────────────────────
-- RLS — all tables deny-by-default, service role has full access
-- ────────────────────────────────────────────────────────────
alter table public.affiliates           enable row level security;
alter table public.affiliate_commissions enable row level security;
alter table public.crypto_payments      enable row level security;

-- affiliates: service role only (payout_wallet, commission_rate must not be public)
drop policy if exists "affiliates_service_role_all"            on public.affiliates;
drop policy if exists "Public insert affiliates"               on public.affiliates;
drop policy if exists "Public select affiliates"               on public.affiliates;
drop policy if exists "Affiliates can select own row"          on public.affiliates;
drop policy if exists "Users can insert affiliates"            on public.affiliates;
create policy "affiliates_service_role_all"
  on public.affiliates for all to service_role
  using (true) with check (true);

-- affiliate_commissions: service role only
drop policy if exists "affiliate_commissions_service_role_all" on public.affiliate_commissions;
drop policy if exists "Public insert commissions"              on public.affiliate_commissions;
drop policy if exists "Public select commissions"              on public.affiliate_commissions;
drop policy if exists "Users can select own commissions"       on public.affiliate_commissions;
create policy "affiliate_commissions_service_role_all"
  on public.affiliate_commissions for all to service_role
  using (true) with check (true);

-- crypto_payments: users may read their own rows; all writes are service role
drop policy if exists "crypto_payments_service_role_all"  on public.crypto_payments;
drop policy if exists "Users can select own payments"     on public.crypto_payments;
drop policy if exists "Public insert crypto_payments"     on public.crypto_payments;
drop policy if exists "Users can insert crypto_payments"  on public.crypto_payments;
drop policy if exists "Users can update crypto_payments"  on public.crypto_payments;
create policy "Users can select own payments"
  on public.crypto_payments for select
  using (auth.uid() = user_id);
create policy "crypto_payments_service_role_all"
  on public.crypto_payments for all to service_role
  using (true) with check (true);
