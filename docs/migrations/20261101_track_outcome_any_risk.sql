-- Track Outcome is no longer limited to risk scores of 50+.
-- Token Scanner receipts may store any canonical score from 0 through 100.
-- Base Radar receipts still store a null risk score.
begin;

alter table public.tracked_token_outcomes drop constraint if exists tracked_token_outcomes_baseline_risk_score_check;
alter table public.tracked_token_outcomes drop constraint if exists tracked_token_outcomes_baseline_risk_by_source;
alter table public.tracked_token_outcomes add constraint tracked_token_outcomes_baseline_risk_by_source check (
  (coalesce(baseline_snapshot_json->>'source', 'token_scanner') = 'token_scanner' and baseline_risk_score is not null and baseline_risk_score between 0 and 100)
  or (coalesce(baseline_snapshot_json->>'source', 'token_scanner') = 'base_radar' and baseline_risk_score is null)
);

commit;
