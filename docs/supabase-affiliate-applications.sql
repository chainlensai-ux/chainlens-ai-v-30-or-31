create extension if not exists pgcrypto;

create table if not exists public.affiliates (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  x_handle text,
  telegram text,
  audience_size text,
  promotion_plan text,
  payout_wallet text,
  referral_code text unique not null,
  status text not null default 'pending',
  commission_rate numeric not null default 0.30,
  created_at timestamptz not null default now()
);

create table if not exists public.affiliate_commissions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid references public.affiliates(id) on delete set null,
  buyer_user_id uuid,
  payment_id text,
  referral_code text,
  plan text,
  payment_amount numeric,
  commission_rate numeric not null default 0.30,
  commission_amount numeric,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists public.crypto_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  order_id text unique not null,
  payment_id text,
  plan text not null,
  amount_usd numeric not null,
  status text not null default 'created',
  referral_code text,
  affiliate_id uuid references public.affiliates(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists affiliate_commissions_payment_id_uidx on public.affiliate_commissions(payment_id) where payment_id is not null;
create index if not exists affiliates_referral_code_idx on public.affiliates(referral_code);
create index if not exists affiliates_status_idx on public.affiliates(status);
create index if not exists crypto_payments_order_id_idx on public.crypto_payments(order_id);

alter table public.affiliates enable row level security;
alter table public.affiliate_commissions enable row level security;
alter table public.crypto_payments enable row level security;
