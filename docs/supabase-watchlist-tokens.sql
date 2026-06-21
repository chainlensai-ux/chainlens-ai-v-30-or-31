-- ChainLens AI — Token Scanner tracked tokens
-- Apply in Supabase SQL editor to create/repair public.watchlist_tokens.

create extension if not exists pgcrypto;

create table if not exists public.watchlist_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contract_address text not null,
  symbol text,
  created_at timestamptz not null default now(),
  saved_at timestamptz not null default now()
);

alter table public.watchlist_tokens
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists contract_address text,
  add column if not exists symbol text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists saved_at timestamptz not null default now();

update public.watchlist_tokens
set saved_at = coalesce(saved_at, created_at, now()),
    created_at = coalesce(created_at, saved_at, now());

alter table public.watchlist_tokens
  alter column id set default gen_random_uuid(),
  alter column user_id set not null,
  alter column contract_address set not null,
  alter column created_at set default now(),
  alter column saved_at set default now();

create unique index if not exists watchlist_tokens_user_contract_idx
  on public.watchlist_tokens (user_id, lower(contract_address));

alter table public.watchlist_tokens enable row level security;

-- Remove broader/legacy policies, then install the required auth.uid() = user_id policies.
drop policy if exists "Users can select own token watchlist" on public.watchlist_tokens;
drop policy if exists "Users can insert own token watchlist" on public.watchlist_tokens;
drop policy if exists "Users can delete own token watchlist" on public.watchlist_tokens;

drop policy if exists watchlist_tokens_select_own on public.watchlist_tokens;
drop policy if exists watchlist_tokens_insert_own on public.watchlist_tokens;
drop policy if exists watchlist_tokens_delete_own on public.watchlist_tokens;

create policy watchlist_tokens_select_own
  on public.watchlist_tokens
  for select
  using (auth.uid() = user_id);

create policy watchlist_tokens_insert_own
  on public.watchlist_tokens
  for insert
  with check (auth.uid() = user_id);

create policy watchlist_tokens_delete_own
  on public.watchlist_tokens
  for delete
  using (auth.uid() = user_id);
