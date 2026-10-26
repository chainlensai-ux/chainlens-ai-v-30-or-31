-- Stored wallet history (src/modules/storedHistory). Server-side only (service role).
-- Run once in the Supabase SQL editor before setting WALLET_STORED_HISTORY=shadow.
--
-- wallet_history_meta: one row per (wallet, chain): per-stream coverage cursors, a revision for
-- optimistic concurrency, and a short writer lease so two scans never interleave writes.
-- wallet_history_chunks: the transfers, one row per (wallet, chain, UTC month).
--
-- Safe to wipe at any time (both tables): wallets simply rebuild their history on the next scans.

create table if not exists wallet_history_meta (
  wallet          text not null,
  chain           text not null,
  version         integer not null default 1,
  rev             integer not null default 0,
  cursors         jsonb not null default '{}'::jsonb,
  transfer_count  integer not null default 0,
  lease_token     text,
  lease_until     timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (wallet, chain)
);

create table if not exists wallet_history_chunks (
  wallet      text not null,
  chain       text not null,
  chunk       text not null,            -- 'YYYY-MM' (UTC) or 'undated'
  transfers   jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (wallet, chain, chunk)
);

create index if not exists idx_wallet_history_chunks_wallet_chain
  on wallet_history_chunks (wallet, chain);

-- Service-role only; never exposed to anonymous/user clients.
alter table wallet_history_meta enable row level security;
alter table wallet_history_chunks enable row level security;
