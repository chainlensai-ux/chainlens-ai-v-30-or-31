create table if not exists public.token_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chain text not null,
  token_address text not null,
  token_symbol text,
  token_name text,
  risk_label text,
  score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, chain, token_address)
);

alter table public.token_watchlist enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'token_watchlist'
      and policyname = 'Users can read own token watchlist'
  ) then
    create policy "Users can read own token watchlist"
    on public.token_watchlist for select
    using (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'token_watchlist'
      and policyname = 'Users can insert own token watchlist'
  ) then
    create policy "Users can insert own token watchlist"
    on public.token_watchlist for insert
    with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'token_watchlist'
      and policyname = 'Users can update own token watchlist'
  ) then
    create policy "Users can update own token watchlist"
    on public.token_watchlist for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'token_watchlist'
      and policyname = 'Users can delete own token watchlist'
  ) then
    create policy "Users can delete own token watchlist"
    on public.token_watchlist for delete
    using (auth.uid() = user_id);
  end if;
end $$;
