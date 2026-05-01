-- ChainLens AI Whale Alerts schema
-- Run before docs/whale-wallets-seed.sql

create extension if not exists pgcrypto;

create table if not exists public.tracked_wallets (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  label text,
  category text,
  confidence numeric,
  source text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.whale_alerts (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  wallet_label text,
  token_address text,
  token_symbol text,
  token_name text,
  alert_type text not null,
  side text,
  amount_usd numeric,
  amount_token numeric,
  tx_hash text,
  chain text not null default 'base',
  severity text,
  summary text,
  occurred_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_tracked_wallets_address on public.tracked_wallets (address);
create index if not exists idx_tracked_wallets_is_active on public.tracked_wallets (is_active);

create index if not exists idx_whale_alerts_occurred_at_desc on public.whale_alerts (occurred_at desc);
create index if not exists idx_whale_alerts_wallet_address on public.whale_alerts (wallet_address);
create index if not exists idx_whale_alerts_token_address on public.whale_alerts (token_address);
create index if not exists idx_whale_alerts_alert_type on public.whale_alerts (alert_type);
create index if not exists idx_whale_alerts_severity on public.whale_alerts (severity);

create unique index if not exists uq_whale_alerts_tx_wallet_token_type
  on public.whale_alerts (tx_hash, wallet_address, token_address, alert_type)
  where tx_hash is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tracked_wallets_updated_at on public.tracked_wallets;
create trigger trg_tracked_wallets_updated_at
before update on public.tracked_wallets
for each row
execute function public.set_updated_at();

alter table public.tracked_wallets enable row level security;
alter table public.whale_alerts enable row level security;

-- Server routes should use SUPABASE_SERVICE_ROLE_KEY only on the server.
-- Do not expose service role credentials to client-side code.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tracked_wallets'
      and policyname = 'tracked_wallets_service_role_all'
  ) then
    create policy tracked_wallets_service_role_all
      on public.tracked_wallets
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'whale_alerts'
      and policyname = 'whale_alerts_service_role_all'
  ) then
    create policy whale_alerts_service_role_all
      on public.whale_alerts
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;
