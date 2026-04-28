-- ChainLens user settings + progression persistence
-- Run in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.user_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  theme text not null default 'dark',
  accent_color text not null default 'mint',
  default_chain text not null default 'base',
  clark_detail_level text not null default 'normal',
  saved_layout jsonb not null default '{}'::jsonb,
  saved_filters jsonb not null default '{}'::jsonb,
  onboarding_progress jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_settings_user_id_idx on public.user_settings(user_id);

alter table public.user_settings enable row level security;

drop policy if exists "Users can select own settings" on public.user_settings;
create policy "Users can select own settings"
  on public.user_settings
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own settings" on public.user_settings;
create policy "Users can insert own settings"
  on public.user_settings
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own settings" on public.user_settings;
create policy "Users can update own settings"
  on public.user_settings
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Optional convenience trigger to keep updated_at current.
create or replace function public.set_current_timestamp_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_user_settings_updated_at on public.user_settings;
create trigger trg_user_settings_updated_at
before update on public.user_settings
for each row execute procedure public.set_current_timestamp_updated_at();
