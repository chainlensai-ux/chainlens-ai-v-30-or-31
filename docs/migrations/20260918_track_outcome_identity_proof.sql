-- Versioned identity evidence for mutable market observations. Frozen scan receipts are unchanged.
alter table public.tracked_token_outcomes
  add column if not exists market_observation_json jsonb;

alter table public.tracked_token_outcomes
  drop constraint if exists tracked_token_outcomes_market_observation_object;
alter table public.tracked_token_outcomes
  add constraint tracked_token_outcomes_market_observation_object
  check (market_observation_json is null or jsonb_typeof(market_observation_json) = 'object');

comment on column public.tracked_token_outcomes.market_observation_json is
  'Versioned exact chain + priced-token identity proof for current market observations. Legacy null rows remain pending until refreshed.';
