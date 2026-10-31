-- REVIEW / APPROVAL REQUIRED: never applied by application startup or the build.
-- New private account history; the legacy shared, expiring scan_memory table is untouched.
begin;
create table if not exists public.cortex_account_scan_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  chain_id integer not null,
  chain text not null,
  token_address text not null,
  scan_request_id text not null check (length(scan_request_id) between 1 and 160),
  observed_at timestamptz not null,
  scanner_version text not null,
  risk_methodology_version text not null,
  risk_score integer check (risk_score between 0 and 100),
  risk_label text not null,
  confidence text not null check (confidence in ('high','medium','low')),
  coverage_percent numeric not null check (coverage_percent between 0 and 100),
  evidence_snapshot jsonb not null check (jsonb_typeof(evidence_snapshot) = 'object' and pg_column_size(evidence_snapshot) <= 65536),
  created_at timestamptz not null default now(),
  constraint cortex_account_chain check ((chain = 'eth' and chain_id = 1) or (chain = 'base' and chain_id = 8453) or (chain = 'bnb' and chain_id = 56) or (chain = 'robinhood' and chain_id = 4663) or (chain = 'solana' and chain_id = 101)),
  constraint cortex_account_token check ((chain = 'solana' and token_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') or (chain <> 'solana' and token_address ~ '^0x[0-9a-f]{40}$')),
  unique(user_id, chain_id, token_address, scan_request_id)
);
create index if not exists cortex_account_history_lookup on public.cortex_account_scan_history(user_id, chain_id, token_address, observed_at desc);
alter table public.cortex_account_scan_history enable row level security;
alter table public.cortex_account_scan_history force row level security;
revoke all on public.cortex_account_scan_history from public, anon, authenticated;
grant select on public.cortex_account_scan_history to authenticated;
-- Only trusted completed server scans may insert. No client-supplied scores, updates or deletion.
grant select, insert on public.cortex_account_scan_history to service_role;
create policy cortex_account_history_read_own on public.cortex_account_scan_history for select to authenticated using ((select auth.uid()) = user_id);
-- No expiry column, TTL, scheduled cleanup or automatic deletion. Deletion requires a separate approved policy.
commit;
