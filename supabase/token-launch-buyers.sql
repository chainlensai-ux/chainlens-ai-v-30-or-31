-- Finalized evidence for the bounded first-trade window only. This is not every launch buyer.
-- Provisional windows remain in short-lived KV. Do not apply this file to Production from a local review.
-- Comparisons use IS TRUE so a missing JSON field cannot pass a check as NULL.
create or replace function early_buyer_buyers_have_proofs(evidence jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(bool_and(
    jsonb_typeof(buyer->'evidence') = 'array'
    and jsonb_array_length(buyer->'evidence') > 0
  ), true)
  from jsonb_array_elements(
    case when jsonb_typeof(evidence->'buyers') = 'array' then evidence->'buyers' else '[]'::jsonb end
  ) buyer
$$;

create table if not exists token_launch_buyers (
  chain text not null check (chain in ('base', 'eth')),
  token text not null check (token ~ '^0x[0-9a-f]{40}$'),
  pool text not null check (pool ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$'),
  launch_block bigint not null check (launch_block >= 0),
  window_end_block bigint not null check (window_end_block >= launch_block),
  status text not null check (status = 'verified'),
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object'
    and (evidence->>'status' = 'verified') is true
    and (evidence->'launch'->>'pool' = pool) is true
    and ((evidence->'launch'->>'block')::bigint = launch_block) is true
    and ((evidence->'window'->>'startBlock')::bigint >= launch_block) is true
    and ((evidence->'window'->>'endBlock')::bigint = window_end_block) is true
    and ((evidence->'window'->>'endBlock')::bigint >= (evidence->'window'->>'startBlock')::bigint) is true
    and (evidence->'coverage'->>'provisional' = 'false') is true
    and (evidence->'coverage'->>'capped' = 'false') is true
    and (evidence->'coverage'->>'scope' = 'bounded_first_trade_window') is true
    and (evidence->'discovery'->>'complete' = 'true') is true
    and jsonb_typeof(evidence->'buyers') = 'array'
    and early_buyer_buyers_have_proofs(evidence)
  ),
  version integer not null check (version = 2),
  created_at timestamptz not null default now(),
  primary key (chain, token)
);

alter table token_launch_buyers enable row level security;
-- Service role is the only reader/writer; no anonymous or authenticated policies.
-- Supabase does not grant table privileges automatically. Reapplying these statements is safe.
revoke all privileges on table public.token_launch_buyers from public;
revoke all privileges on table public.token_launch_buyers from anon, authenticated;
grant select, insert, update, delete on table public.token_launch_buyers to service_role;
