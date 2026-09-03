-- ChainLens AI Whale Alerts schema
-- Run before docs/whale-wallets-seed.sql

create extension if not exists pgcrypto;

create table if not exists public.tracked_wallets (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  -- wallet_address/user_id/chain_id make a FOMO add account-owned rather than global.
  wallet_address text,
  user_id uuid references auth.users(id) on delete cascade,
  chain_id bigint,
  chain_slug text not null default 'base',
  source_handle text,
  source_rank integer,
  added_at timestamptz,
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
  owner_user_id uuid references auth.users(id) on delete cascade,
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

-- FOMO BOARD METADATA, DISCLOSED: additive columns so a wallet added from the FOMO board's
-- "+ Add" button records which FOMO trader/rank/window it came from, not just a bare address.
-- app/api/whale-alerts/tracked-wallets/route.ts writes these when present and falls back to the
-- original columns (address/label/category/source/is_active) if this migration hasn't been run
-- yet, so re-running this file is safe and never required for Add to keep working.
alter table public.tracked_wallets
  add column if not exists wallet_address text,
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists chain_id bigint,
  add column if not exists chain_slug text not null default 'base',
  add column if not exists source_handle text,
  add column if not exists source_rank integer,
  add column if not exists added_at timestamptz,
  add column if not exists tags text[] not null default '{}',
  add column if not exists fomo_handle text,
  add column if not exists fomo_rank integer,
  add column if not exists fomo_window text;

-- Existing installations created `address text unique`. Remove that global uniqueness before
-- enabling user-scoped tracking, then backfill canonical address/chain fields for seeded rows.
alter table public.tracked_wallets drop constraint if exists tracked_wallets_address_key;
drop index if exists public.tracked_wallets_address_key;
update public.tracked_wallets
set wallet_address = lower(address),
    chain_id = coalesce(chain_id, 8453),
    added_at = coalesce(added_at, created_at)
where wallet_address is null or chain_id is null or added_at is null;

create unique index if not exists uq_tracked_wallets_user_chain_wallet
  on public.tracked_wallets (user_id, chain_id, wallet_address)
  where user_id is not null;

create index if not exists idx_tracked_wallets_address on public.tracked_wallets (address);
create index if not exists idx_tracked_wallets_is_active on public.tracked_wallets (is_active);
create index if not exists idx_tracked_wallets_user_chain_active on public.tracked_wallets (user_id, chain_id, is_active);

create index if not exists idx_whale_alerts_occurred_at_desc on public.whale_alerts (occurred_at desc);
create index if not exists idx_whale_alerts_wallet_address on public.whale_alerts (wallet_address);
create index if not exists idx_whale_alerts_token_address on public.whale_alerts (token_address);
create index if not exists idx_whale_alerts_alert_type on public.whale_alerts (alert_type);
create index if not exists idx_whale_alerts_severity on public.whale_alerts (severity);

-- FOMO-added trackers produce private feed rows. Existing system rows retain NULL ownership.
alter table public.whale_alerts add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;
drop index if exists public.uq_whale_alerts_tx_wallet_token_type;
alter table public.whale_alerts drop constraint if exists uq_whale_alerts_tx_wallet_token_type_owner;
alter table public.whale_alerts add constraint uq_whale_alerts_tx_wallet_token_type_owner
  unique nulls not distinct (tx_hash, wallet_address, token_address, alert_type, owner_user_id);
create index if not exists idx_whale_alerts_owner_user_id on public.whale_alerts (owner_user_id, occurred_at desc);

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
