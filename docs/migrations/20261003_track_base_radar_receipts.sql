-- Base Radar → Track receipts. Additive: every existing Token Scanner receipt keeps the exact same
-- 50–100 risk-score constraint. A Base Radar receipt (baseline_snapshot_json.source = 'base_radar')
-- carries no Risk Score — the Radar score is higher-is-stronger, the opposite direction — so its
-- risk column is NULL and its Radar score/label live in the immutable snapshot JSON.
begin;

alter table public.tracked_token_outcomes alter column baseline_risk_score drop not null;
alter table public.tracked_token_outcomes drop constraint if exists tracked_token_outcomes_baseline_risk_score_check;
alter table public.tracked_token_outcomes drop constraint if exists tracked_token_outcomes_baseline_risk_by_source;
-- NULL-safe on purpose: a CHECK that evaluates to NULL passes in PostgreSQL, so every branch is explicit.
alter table public.tracked_token_outcomes add constraint tracked_token_outcomes_baseline_risk_by_source check (
  (coalesce(baseline_snapshot_json->>'source', 'token_scanner') = 'token_scanner' and baseline_risk_score is not null and baseline_risk_score between 50 and 100)
  or (coalesce(baseline_snapshot_json->>'source', 'token_scanner') = 'base_radar' and baseline_risk_score is null)
);

-- Same function, same lock, same plan limit, same immutable insert. One addition: a Base Radar receipt
-- is a duplicate when the account already tracks this chain + token from ANY source, so repeated Track
-- clicks (or a token already tracked from Token Scanner) never create a second active receipt.
create or replace function public.create_tracked_outcome(p_user uuid, p_snapshot jsonb, p_limit integer)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare existing public.tracked_token_outcomes; total integer;
begin
  if (p_snapshot->>'userId')::uuid is distinct from p_user then raise exception 'Snapshot user mismatch'; end if;
  perform pg_advisory_xact_lock(hashtextextended('token_outcomes:' || p_user::text, 0));
  if p_snapshot->>'source' = 'base_radar' then
    select * into existing from public.tracked_token_outcomes where user_id=p_user and chain=p_snapshot->>'chain' and token_address=p_snapshot->>'tokenAddress' order by tracked_at asc limit 1;
  else
    select * into existing from public.tracked_token_outcomes where user_id=p_user and chain=p_snapshot->>'chain' and token_address=p_snapshot->>'tokenAddress' and scan_id=p_snapshot->>'scanId';
  end if;
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
