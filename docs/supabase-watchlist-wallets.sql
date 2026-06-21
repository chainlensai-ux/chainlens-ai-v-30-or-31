-- ============================================================
-- ChainLens AI — Wallet Watchlist
-- Run in Supabase SQL Editor (production + staging).
-- Backs app/api/watchlist/wallets/route.ts (used by the
-- Wallet Scanner "Add To Watchlist" action).
-- Safe to re-run: all creates use IF NOT EXISTS.
-- ============================================================

create table if not exists public.watchlist_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  address text not null,
  label text,
  portfolio_value numeric,
  chain_mode text,
  source text default 'wallet-scanner',
  saved_at timestamptz not null default now(),
  unique (user_id, address)
);

alter table public.watchlist_wallets enable row level security;

drop policy if exists "Users can select own wallet watchlist" on public.watchlist_wallets;
create policy "Users can select own wallet watchlist"
  on public.watchlist_wallets
  for select
  using (auth.uid() = user_id);

-- Inserts/updates/deletes go through the service-role API route only;
-- no direct client write policy is granted.
