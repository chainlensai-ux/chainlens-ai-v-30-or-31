begin;

-- Provider gaps previously persisted as numeric zero must become unknown. Derived loss math is
-- cleared with it so existing receipts cannot render a fabricated -100% outcome.
update public.tracked_token_outcomes
set current_price_usd = null,
    price_change_pct = null,
    outcome_status = case when outcome_status = 'rugged' and after_evidence_json->>'verifiedTradingBlocked' = 'true' then 'rugged' else 'unavailable' end,
    outcome_confidence = case when outcome_status = 'rugged' and after_evidence_json->>'verifiedTradingBlocked' = 'true' then outcome_confidence else 'low' end,
    outcome_reasons_json = case when outcome_status = 'rugged' and after_evidence_json->>'verifiedTradingBlocked' = 'true'
      then outcome_reasons_json
      else '["Current market price unavailable. Outcome pending; no loss is inferred from missing data."]'::jsonb end
where (current_price_usd is null and price_change_pct is not null)
   or (current_price_usd is not null and (current_price_usd <= 0 or current_price_usd in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)));

alter table public.tracked_token_outcomes
  add constraint tracked_outcome_current_price_positive check (current_price_usd is null or (current_price_usd > 0 and current_price_usd not in ('NaN'::double precision, 'Infinity'::double precision))),
  add constraint tracked_outcome_change_requires_price check (current_price_usd is not null or price_change_pct is null);

commit;
