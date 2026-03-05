-- ================================================================
-- ChainLens AI — Supabase Schema
-- Run this entire file in the Supabase SQL Editor
-- Dashboard → SQL Editor → New Query → Paste → Run
-- ================================================================

-- PROFILES (extends Supabase auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default 'Trader',
  email text,
  plan text not null default 'free' check (plan in ('free','pro','elite')),
  joined timestamptz default now(),
  stripe_customer_id text,
  stripe_subscription_id text,
  updated_at timestamptz default now()
);

-- PROOFVAULT predictions
create table if not exists public.proofvault (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  coin text not null,
  coin_id text,
  dir text not null check (dir in ('up','down')),
  days int not null,
  reasoning text,
  entry_price numeric,
  resolved_price numeric,
  status text default 'pending' check (status in ('pending','correct','wrong')),
  resolves_at timestamptz,
  created_at timestamptz default now()
);

-- GHOST TRADES (paper trading portfolio)
create table if not exists public.ghost_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  type text not null check (type in ('BUY','SELL')),
  symbol text not null,
  coin_id text,
  amount numeric not null,
  price numeric not null,
  units numeric not null,
  coach text,
  created_at timestamptz default now()
);

-- GHOST PORTFOLIO STATE (cash + holdings snapshot)
create table if not exists public.ghost_portfolio (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null unique,
  cash numeric default 10000,
  holdings jsonb default '{}',
  start_value numeric default 10000,
  updated_at timestamptz default now()
);

-- TRADE JOURNAL
create table if not exists public.trade_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  coin text not null,
  type text not null,
  amount numeric,
  price numeric,
  reason text,
  emotion text,
  coaching text,
  created_at timestamptz default now()
);

-- PRICE ALERTS
create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  coin_id text not null,
  coin_name text,
  direction text not null check (direction in ('above','below')),
  target_price numeric not null,
  triggered boolean default false,
  created_at timestamptz default now()
);

-- SAVED WALLETS
create table if not exists public.saved_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  address text not null,
  label text,
  chain text,
  created_at timestamptz default now()
);

-- LEADERBOARD (public — derived from proofvault)
create table if not exists public.leaderboard (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null unique,
  display_name text not null,
  country text default '🌍 Global',
  total int default 0,
  correct int default 0,
  accuracy numeric default 0,
  updated_at timestamptz default now()
);

-- ================================================================
-- ROW LEVEL SECURITY — users can only read/write their own data
-- ================================================================

alter table public.profiles enable row level security;
alter table public.proofvault enable row level security;
alter table public.ghost_trades enable row level security;
alter table public.ghost_portfolio enable row level security;
alter table public.trade_journal enable row level security;
alter table public.price_alerts enable row level security;
alter table public.saved_wallets enable row level security;
alter table public.leaderboard enable row level security;

-- Profiles: own row only
create policy "profiles_own" on public.profiles for all using (auth.uid() = id);

-- All data tables: own rows only
create policy "proofvault_own" on public.proofvault for all using (auth.uid() = user_id);
create policy "ghost_trades_own" on public.ghost_trades for all using (auth.uid() = user_id);
create policy "ghost_portfolio_own" on public.ghost_portfolio for all using (auth.uid() = user_id);
create policy "trade_journal_own" on public.trade_journal for all using (auth.uid() = user_id);
create policy "price_alerts_own" on public.price_alerts for all using (auth.uid() = user_id);
create policy "saved_wallets_own" on public.saved_wallets for all using (auth.uid() = user_id);

-- Leaderboard: public read, own write
create policy "leaderboard_read" on public.leaderboard for select using (true);
create policy "leaderboard_write" on public.leaderboard for all using (auth.uid() = user_id);

-- ================================================================
-- AUTO-UPDATE leaderboard when proofvault changes
-- ================================================================
create or replace function update_leaderboard()
returns trigger language plpgsql security definer as $$
declare
  v_total int;
  v_correct int;
  v_accuracy numeric;
  v_name text;
begin
  select count(*), count(*) filter (where status = 'correct')
  into v_total, v_correct
  from public.proofvault
  where user_id = coalesce(new.user_id, old.user_id) and status != 'pending';

  if v_total = 0 then return new; end if;

  v_accuracy := round((v_correct::numeric / v_total) * 100, 1);

  select name into v_name from public.profiles where id = coalesce(new.user_id, old.user_id);

  insert into public.leaderboard (user_id, display_name, total, correct, accuracy, updated_at)
  values (coalesce(new.user_id, old.user_id), coalesce(v_name, 'Trader'), v_total, v_correct, v_accuracy, now())
  on conflict (user_id) do update set
    total = v_total, correct = v_correct, accuracy = v_accuracy, updated_at = now();

  return new;
end;
$$;

drop trigger if exists proofvault_lb_trigger on public.proofvault;
create trigger proofvault_lb_trigger
after insert or update on public.proofvault
for each row execute function update_leaderboard();

-- ================================================================
-- Done. Now add these env vars to Vercel:
-- SUPABASE_URL        = https://xxxx.supabase.co
-- SUPABASE_SERVICE_KEY = your service role key (Settings → API)
-- ================================================================
