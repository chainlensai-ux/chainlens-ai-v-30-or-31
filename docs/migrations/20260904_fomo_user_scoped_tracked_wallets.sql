-- FOMO Board user-scoped tracked wallets
-- Apply after docs/supabase-whale-alerts.sql on existing projects.

alter table public.tracked_wallets
  add column if not exists wallet_address text,
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists chain_id bigint,
  add column if not exists source_handle text,
  add column if not exists source_rank integer,
  add column if not exists added_at timestamptz;

-- The old schema made address globally unique. A wallet must instead be unique only for one
-- account on one chain, so two users can independently track the same wallet.
alter table public.tracked_wallets drop constraint if exists tracked_wallets_address_key;
drop index if exists public.tracked_wallets_address_key;

update public.tracked_wallets
set wallet_address = lower(address),
    chain_id = coalesce(chain_id, 8453),
    added_at = coalesce(added_at, created_at)
where wallet_address is null or chain_id is null or added_at is null;

create unique index if not exists uq_tracked_wallets_user_chain_wallet
  on public.tracked_wallets (user_id, chain_id, wallet_address)
  where user_id is not null;
create index if not exists idx_tracked_wallets_user_chain_active
  on public.tracked_wallets (user_id, chain_id, is_active);

alter table public.whale_alerts
  add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;
drop index if exists public.uq_whale_alerts_tx_wallet_token_type;
alter table public.whale_alerts drop constraint if exists uq_whale_alerts_tx_wallet_token_type_owner;
alter table public.whale_alerts add constraint uq_whale_alerts_tx_wallet_token_type_owner
  unique nulls not distinct (tx_hash, wallet_address, token_address, alert_type, owner_user_id);
create index if not exists idx_whale_alerts_owner_user_id
  on public.whale_alerts (owner_user_id, occurred_at desc);
