-- Whale Alerts: per-wallet "last scanned" timestamp so sync batches take the stalest wallets first.
-- Safe to run more than once. Sync works without it (falls back to offset order) until applied.
alter table public.tracked_wallets add column if not exists last_scanned_at timestamptz;
create index if not exists idx_tracked_wallets_last_scanned
  on public.tracked_wallets (last_scanned_at asc nulls first);
notify pgrst, 'reload schema';
