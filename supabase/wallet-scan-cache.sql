-- Persistent cache + cooldown table for Wallet Scanner deep scans.
-- Survives Vercel serverless cold-starts; shared across all instances.
-- Run once in the Supabase SQL editor or via migrations.

create table if not exists wallet_scan_cache (
  cache_key   text primary key,
  address     text not null,
  scan_mode   text not null,       -- 'deep' | 'basic' | 'historical' | 'cooldown'
  chain_key   text not null,
  payload     jsonb,               -- null for cooldown rows
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  updated_at  timestamptz not null default now()
);

-- Fast expiry-based lookups
create index if not exists idx_wallet_scan_cache_expires_at
  on wallet_scan_cache (expires_at);

-- Fast address-based lookups
create index if not exists idx_wallet_scan_cache_address
  on wallet_scan_cache (address);

-- Service-role only; no RLS needed for server-side cache
-- (table is never exposed to anonymous/user clients)
