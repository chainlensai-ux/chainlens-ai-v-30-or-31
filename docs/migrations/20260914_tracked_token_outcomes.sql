begin;
create table if not exists public.tracked_token_outcomes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chain text not null check (chain in ('base','eth','bnb','robinhood','solana')),
  token_address text not null, scan_id text not null,
  tracked_at timestamptz not null default now(),
  baseline_price_usd double precision, baseline_liquidity_usd double precision, baseline_market_cap_usd double precision,
  baseline_risk_score double precision not null check (baseline_risk_score between 50 and 100),
  baseline_verdict text not null, baseline_snapshot_json jsonb not null,
  current_price_usd double precision, current_liquidity_usd double precision,
  price_change_pct double precision, liquidity_change_pct double precision,
  outcome_status text not null default 'watching' check (outcome_status in ('watching','pumped','dumped','rugged','unavailable')),
  outcome_confidence text not null default 'low' check (outcome_confidence in ('low','medium','high')),
  outcome_reasons_json jsonb not null default '["Waiting for the first market observation."]',
  market_source text, last_checked_at timestamptz, refresh_claimed_at timestamptz, after_evidence_json jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id, chain, token_address, scan_id)
);
alter table public.tracked_token_outcomes enable row level security;
create policy outcomes_read_own on public.tracked_token_outcomes for select to authenticated using ((select auth.uid()) = user_id);
-- Inserts are server-only: the HTTP API verifies session and signed scanner receipt.
-- No client insert/update policy can bypass evidence signatures or plan limits.
revoke all on public.tracked_token_outcomes from anon, authenticated;
grant select on public.tracked_token_outcomes to authenticated;
grant all on public.tracked_token_outcomes to service_role;
create index outcomes_user_checked on public.tracked_token_outcomes(user_id, last_checked_at);

create function public.preserve_outcome_baseline() returns trigger language plpgsql set search_path = public as $$
begin
  if row(new.user_id,new.chain,new.token_address,new.scan_id,new.tracked_at,new.baseline_price_usd,new.baseline_liquidity_usd,new.baseline_market_cap_usd,new.baseline_risk_score,new.baseline_verdict,new.baseline_snapshot_json)
     is distinct from row(old.user_id,old.chain,old.token_address,old.scan_id,old.tracked_at,old.baseline_price_usd,old.baseline_liquidity_usd,old.baseline_market_cap_usd,old.baseline_risk_score,old.baseline_verdict,old.baseline_snapshot_json) then
    raise exception 'Outcome baseline is immutable';
  end if;
  new.updated_at = now(); return new;
end $$;
create trigger immutable_outcome_baseline before update on public.tracked_token_outcomes for each row execute function public.preserve_outcome_baseline();

-- A per-account transaction lock makes limits and duplicate handling atomic across instances.
create function public.create_tracked_outcome(p_user uuid, p_snapshot jsonb, p_limit integer)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare existing public.tracked_token_outcomes; total integer;
begin
  if (p_snapshot->>'userId')::uuid is distinct from p_user then raise exception 'Snapshot user mismatch'; end if;
  perform pg_advisory_xact_lock(hashtextextended('token_outcomes:' || p_user::text, 0));
  select * into existing from public.tracked_token_outcomes where user_id=p_user and chain=p_snapshot->>'chain' and token_address=p_snapshot->>'tokenAddress' and scan_id=p_snapshot->>'scanId';
  if found then return jsonb_build_object('outcome',to_jsonb(existing),'duplicate',true); end if;
  select count(*) into total from public.tracked_token_outcomes where user_id=p_user;
  if total >= p_limit then raise exception 'Tracked outcome plan limit reached'; end if;
  insert into public.tracked_token_outcomes(user_id,chain,token_address,scan_id,baseline_price_usd,baseline_liquidity_usd,baseline_market_cap_usd,baseline_risk_score,baseline_verdict,baseline_snapshot_json)
  values(p_user,p_snapshot->>'chain',p_snapshot->>'tokenAddress',p_snapshot->>'scanId',(p_snapshot->>'baselinePriceUsd')::double precision,(p_snapshot->>'baselineLiquidityUsd')::double precision,(p_snapshot->>'baselineMarketCapUsd')::double precision,(p_snapshot->>'baselineRiskScore')::double precision,p_snapshot->>'baselineVerdict',p_snapshot)
  returning * into existing;
  return jsonb_build_object('outcome',to_jsonb(existing),'duplicate',false);
end $$;
revoke all on function public.create_tracked_outcome(uuid,jsonb,integer) from public, anon, authenticated;
grant execute on function public.create_tracked_outcome(uuid,jsonb,integer) to service_role;
commit;
