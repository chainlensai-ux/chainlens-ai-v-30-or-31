-- ChainLens AI — Token Scanner tracked tokens
-- Apply in Supabase SQL editor to create/repair public.watchlist_tokens.

create extension if not exists pgcrypto;

create table if not exists public.watchlist_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contract_address text not null,
  symbol text,
  name text,
  chain text,
  chain_id integer,
  risk_label text,
  score numeric,
  score_type text,
  score_direction text,
  created_at timestamptz not null default now(),
  saved_at timestamptz not null default now()
);

alter table public.watchlist_tokens
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists contract_address text,
  add column if not exists symbol text,
  add column if not exists name text,
  add column if not exists chain text,
  -- CHAIN-ID FIX, DISCLOSED (Track This Token "Could not save this token" diagnosis): the app
  -- already stores `chain` (a text slug: base/eth/bnb/robinhood/solana) but had no numeric chainId
  -- column — added so Robinhood (4663) and every other chain are recorded unambiguously, matching
  -- the same chainId convention app/api/token/route.ts already uses. Nullable: Solana has no EVM
  -- chainId, and that is the honest value, not a gap to paper over.
  add column if not exists chain_id integer,
  add column if not exists risk_label text,
  add column if not exists score numeric,
  add column if not exists score_type text,
  add column if not exists score_direction text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists saved_at timestamptz not null default now();

update public.watchlist_tokens
set saved_at = coalesce(saved_at, created_at, now()),
    created_at = coalesce(created_at, saved_at, now());

-- Backfill chain_id for existing rows from the text chain slug that's always been there. Only
-- fills rows where chain_id is still null — never overwrites a value already set.
update public.watchlist_tokens
set chain_id = case lower(coalesce(chain, 'base'))
  when 'base' then 8453
  when 'eth' then 1
  when 'ethereum' then 1
  when 'bnb' then 56
  when 'bsc' then 56
  when 'robinhood' then 4663
  else null -- solana and any unrecognized slug: honestly null, never guessed
end
where chain_id is null;

alter table public.watchlist_tokens
  alter column id set default gen_random_uuid(),
  alter column user_id set not null,
  alter column contract_address set not null,
  alter column created_at set default now(),
  alter column saved_at set default now();

-- UNIQUE-INDEX FIX, DISCLOSED (Track This Token "Could not save this token" root cause): this
-- index used to be `(user_id, lower(contract_address))` — no chain, and a functional/expression
-- index. Two real bugs came from that: (1) app/api/watchlist/tokens/route.ts's upsert calls
-- target onConflict shapes like `user_id,chain,contract_address` — none of which match a
-- `lower(contract_address)`-only expression index, so EVERY save failed the onConflict match and
-- fell through several wasted round-trips before a plain-insert fallback finally succeeded; and
-- (2) with no chain in the constraint, the same 0x address tracked on two different chains (e.g.
-- a Base token and a Robinhood token that happen to share an address) could never be saved as two
-- separate rows — whichever key existed already, drop the old index and index plain columns
-- (not lower()) scoped by chain: contract_address is already lowercased for EVM by this route's
-- own normalizeWatchlistAddress() before it's ever written (and Solana's case-sensitive base58
-- mint is deliberately never lowercased), so a plain-column index over the value the app actually
-- writes is correct and avoids wrapping a case-sensitive Solana address in lower().
drop index if exists public.watchlist_tokens_user_contract_idx;

create unique index if not exists watchlist_tokens_user_chain_contract_idx
  on public.watchlist_tokens (user_id, chain, contract_address);

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
