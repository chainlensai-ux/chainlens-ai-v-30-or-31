-- ChainLens AI — Clark chat history (folders, chats, messages)
-- Apply in Supabase SQL editor to create/repair the Clark chat history tables.

create extension if not exists pgcrypto;

-- ── Folders ──────────────────────────────────────────────────────────────────
create table if not exists public.clark_chat_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clark_chat_folders
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists name text,
  add column if not exists sort_order int not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.clark_chat_folders enable row level security;

drop policy if exists clark_chat_folders_select_own on public.clark_chat_folders;
drop policy if exists clark_chat_folders_insert_own on public.clark_chat_folders;
drop policy if exists clark_chat_folders_update_own on public.clark_chat_folders;
drop policy if exists clark_chat_folders_delete_own on public.clark_chat_folders;

create policy clark_chat_folders_select_own on public.clark_chat_folders
  for select using (auth.uid() = user_id);
create policy clark_chat_folders_insert_own on public.clark_chat_folders
  for insert with check (auth.uid() = user_id);
create policy clark_chat_folders_update_own on public.clark_chat_folders
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy clark_chat_folders_delete_own on public.clark_chat_folders
  for delete using (auth.uid() = user_id);

-- ── Chats ────────────────────────────────────────────────────────────────────
create table if not exists public.clark_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  folder_id uuid null references public.clark_chat_folders(id) on delete set null,
  title text not null default 'New Clark Chat',
  summary text null,
  last_message_preview text null,
  message_count int not null default 0,
  pinned boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clark_chats
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists folder_id uuid references public.clark_chat_folders(id) on delete set null,
  add column if not exists title text not null default 'New Clark Chat',
  add column if not exists summary text,
  add column if not exists last_message_preview text,
  add column if not exists message_count int not null default 0,
  add column if not exists pinned boolean not null default false,
  add column if not exists archived boolean not null default false,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists clark_chats_user_updated_idx on public.clark_chats (user_id, updated_at desc);
create index if not exists clark_chats_folder_idx on public.clark_chats (folder_id);

alter table public.clark_chats enable row level security;

drop policy if exists clark_chats_select_own on public.clark_chats;
drop policy if exists clark_chats_insert_own on public.clark_chats;
drop policy if exists clark_chats_update_own on public.clark_chats;
drop policy if exists clark_chats_delete_own on public.clark_chats;

create policy clark_chats_select_own on public.clark_chats
  for select using (auth.uid() = user_id);
create policy clark_chats_insert_own on public.clark_chats
  for insert with check (auth.uid() = user_id);
create policy clark_chats_update_own on public.clark_chats
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy clark_chats_delete_own on public.clark_chats
  for delete using (auth.uid() = user_id);

-- ── Messages ─────────────────────────────────────────────────────────────────
create table if not exists public.clark_chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid not null references public.clark_chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.clark_chat_messages
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists chat_id uuid references public.clark_chats(id) on delete cascade,
  add column if not exists role text,
  add column if not exists content text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create index if not exists clark_chat_messages_chat_idx on public.clark_chat_messages (chat_id, created_at);
create index if not exists clark_chat_messages_user_idx on public.clark_chat_messages (user_id);

alter table public.clark_chat_messages enable row level security;

drop policy if exists clark_chat_messages_select_own on public.clark_chat_messages;
drop policy if exists clark_chat_messages_insert_own on public.clark_chat_messages;
drop policy if exists clark_chat_messages_update_own on public.clark_chat_messages;
drop policy if exists clark_chat_messages_delete_own on public.clark_chat_messages;

create policy clark_chat_messages_select_own on public.clark_chat_messages
  for select using (auth.uid() = user_id);
create policy clark_chat_messages_insert_own on public.clark_chat_messages
  for insert with check (auth.uid() = user_id);
create policy clark_chat_messages_update_own on public.clark_chat_messages
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy clark_chat_messages_delete_own on public.clark_chat_messages
  for delete using (auth.uid() = user_id);
