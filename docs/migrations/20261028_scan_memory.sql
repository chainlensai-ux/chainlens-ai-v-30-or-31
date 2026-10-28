-- CORTEX Intelligence Memory Phase 1.
-- Completed EVM Token Scanner observations only.
-- This file is not executed by next build, Vercel, or package scripts.
-- Do not apply it to Production. Apply it only to an isolated database, and only then
-- set the server env CORTEX_SCAN_MEMORY_ENABLED=true. Leave that variable unset everywhere else.
-- The application role cannot insert or update rows. Only record_scan_memory can write,
-- and it enforces the daily cap. service_role has no cap-override argument.

begin;

create extension if not exists pgcrypto;

create table if not exists public.scan_memory (
  id uuid primary key default gen_random_uuid(),
  memory_version smallint not null default 1 check (memory_version = 1),
  scanner_version text not null check (scanner_version = 'token_scanner_response:8'),
  risk_methodology_version text not null check (risk_methodology_version = 'evm_token_risk_score:v1'),
  chain text not null check (chain in ('base','eth','bnb','robinhood')),
  token_address text not null check (token_address ~ '^0x[0-9a-f]{40}$'),
  observed_at timestamptz not null,
  inserted_at timestamptz not null default now(),
  observed_bucket timestamptz not null,
  last_seen_at timestamptz not null default now(),
  seen_count integer not null default 1 check (seen_count > 0),
  expires_at timestamptz not null,
  coverage text not null check (coverage in ('complete','partial','provider_unavailable')),
  coverage_reason text check (coverage_reason is null or coverage_reason in ('market','simulation','holders','lp','partial_section')),
  risk_score smallint not null check (risk_score between 0 and 100),
  risk_label text check (risk_label is null or risk_label in ('Low Risk','Moderate Risk','Caution','High Risk','Extreme Risk')),
  price_usd numeric check (price_usd is null or price_usd > 0),
  liquidity_usd numeric check (liquidity_usd is null or liquidity_usd > 0),
  market_cap_usd numeric check (market_cap_usd is null or market_cap_usd > 0),
  liquidity_band integer,
  holder_points smallint check (holder_points is null or holder_points between 0 and 100),
  holder_basis text,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  dedup_key text not null check (dedup_key ~ '^[0-9a-f]{64}$'),
  signal_json jsonb not null,
  unique (dedup_key, observed_bucket)
);

create index if not exists scan_memory_token_time on public.scan_memory (chain, token_address, observed_at desc);
create index if not exists scan_memory_expiry on public.scan_memory (expires_at);

create table if not exists public.scan_memory_daily (
  day date primary key,
  cap integer not null check (cap > 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  dedup_count integer not null default 0 check (dedup_count >= 0),
  capped_count integer not null default 0 check (capped_count >= 0)
);

create or replace function public.scan_memory_liquidity_band(p_usd numeric)
returns integer
language plpgsql
immutable
set search_path = pg_catalog, public, extensions
as $$
declare
  cents numeric;
  n integer := 0;
  p11 numeric := 1;
  p10 numeric := 1;
  n11 numeric;
  n10 numeric;
begin
  if p_usd is null or p_usd <= 0 or p_usd > 1000000000000000 then
    return null;
  end if;
  cents := trunc(p_usd * 100);
  if cents < 1 then
    return null;
  end if;
  loop
    n11 := p11 * 11;
    n10 := p10 * 10;
    exit when n11 > cents * n10;
    p11 := n11;
    p10 := n10;
    n := n + 1;
    exit when n > 500;
  end loop;
  return n;
end
$$;

create or replace function public.scan_memory_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
begin
  if new.seen_count is distinct from old.seen_count + 1
     or new.last_seen_at < old.last_seen_at
     or new.id is distinct from old.id
     or new.memory_version is distinct from old.memory_version
     or new.scanner_version is distinct from old.scanner_version
     or new.risk_methodology_version is distinct from old.risk_methodology_version
     or new.chain is distinct from old.chain
     or new.token_address is distinct from old.token_address
     or new.observed_at is distinct from old.observed_at
     or new.inserted_at is distinct from old.inserted_at
     or new.observed_bucket is distinct from old.observed_bucket
     or new.expires_at is distinct from old.expires_at
     or new.coverage is distinct from old.coverage
     or new.coverage_reason is distinct from old.coverage_reason
     or new.risk_score is distinct from old.risk_score
     or new.risk_label is distinct from old.risk_label
     or new.price_usd is distinct from old.price_usd
     or new.liquidity_usd is distinct from old.liquidity_usd
     or new.market_cap_usd is distinct from old.market_cap_usd
     or new.liquidity_band is distinct from old.liquidity_band
     or new.holder_points is distinct from old.holder_points
     or new.holder_basis is distinct from old.holder_basis
     or new.evidence_hash is distinct from old.evidence_hash
     or new.dedup_key is distinct from old.dedup_key
     or new.signal_json is distinct from old.signal_json
  then
    raise exception 'scan memory evidence is immutable';
  end if;
  return new;
end
$$;

drop trigger if exists scan_memory_immutable_trigger on public.scan_memory;
create trigger scan_memory_immutable_trigger
before update on public.scan_memory
for each row execute function public.scan_memory_immutable();

create or replace function public.record_scan_memory(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_day date := (timezone('utc', now()))::date;
  v_cap integer;
  v_accepted integer;
  v_chain text;
  v_token text;
  v_scanner text;
  v_method text;
  v_coverage text;
  v_reason text;
  v_score integer;
  v_label text;
  v_price numeric;
  v_liq numeric;
  v_mcap numeric;
  v_band integer;
  v_points integer;
  v_basis text;
  v_observed timestamptz;
  v_honeypot text;
  v_mint text;
  v_blacklist text;
  v_pause text;
  v_lp text;
  v_dev text;
  v_inputs text;
  v_key text;
  v_canonical text;
  v_hash text;
  v_bucket timestamptz;
  v_signal jsonb;
  v_allowed text[] := array[
    'chain','token_address','scanner_version','risk_methodology_version','coverage','coverage_reason',
    'risk_score','risk_label','price_usd','liquidity_usd','market_cap_usd','holder_points','holder_basis',
    'observed_at','honeypot','mint','blacklist','pause','lp_status','dev_status','risk_inputs','evidence_hash'
  ];
  v_extra text;
  v_input jsonb;
  v_status text;
  v_name text;
begin
  perform set_config('statement_timeout', '800ms', true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('outcome','skipped','reason','invalid_signal');
  end if;
  select t.key into v_extra
  from jsonb_each(p_payload) as t(key, value)
  where t.key <> all (v_allowed)
  limit 1;
  if v_extra is not null then
    return jsonb_build_object('outcome','skipped','reason','invalid_signal');
  end if;

  v_chain := p_payload->>'chain';
  v_token := p_payload->>'token_address';
  v_scanner := p_payload->>'scanner_version';
  v_method := p_payload->>'risk_methodology_version';
  v_coverage := p_payload->>'coverage';
  v_reason := nullif(p_payload->>'coverage_reason', '');
  v_score := (p_payload->>'risk_score')::integer;
  v_label := nullif(p_payload->>'risk_label', '');
  v_price := nullif(p_payload->>'price_usd', '')::numeric;
  v_liq := nullif(p_payload->>'liquidity_usd', '')::numeric;
  v_mcap := nullif(p_payload->>'market_cap_usd', '')::numeric;
  v_points := nullif(p_payload->>'holder_points', '')::integer;
  v_basis := nullif(p_payload->>'holder_basis', '');
  v_observed := (p_payload->>'observed_at')::timestamptz;
  v_honeypot := p_payload->>'honeypot';
  v_mint := p_payload->>'mint';
  v_blacklist := p_payload->>'blacklist';
  v_pause := p_payload->>'pause';
  v_lp := p_payload->>'lp_status';
  v_dev := p_payload->>'dev_status';
  v_input := p_payload->'risk_inputs';

  if v_chain not in ('base','eth','bnb','robinhood')
     or v_token !~ '^0x[0-9a-f]{40}$'
     or v_scanner <> 'token_scanner_response:8'
     or v_method <> 'evm_token_risk_score:v1'
     or v_coverage not in ('complete','partial','provider_unavailable')
     or (v_reason is not null and v_reason not in ('market','simulation','holders','lp','partial_section'))
     or v_score is null or v_score < 0 or v_score > 100
     or (v_label is not null and v_label not in ('Low Risk','Moderate Risk','Caution','High Risk','Extreme Risk'))
     or (v_price is not null and v_price <= 0)
     or (v_liq is not null and v_liq <= 0)
     or (v_mcap is not null and v_mcap <= 0)
     or (v_points is not null and (v_points < 0 or v_points > 100))
     or (v_basis is not null and v_basis !~ '^(provider_reported_percent|total_supply:[a-z0-9_]{1,40})$')
     or v_honeypot not in ('1','0','-')
     or v_mint not in ('verified','possible','not_detected','inferred','partial','unavailable')
     or v_blacklist not in ('verified','possible','not_detected','inferred','partial','unavailable')
     or v_pause not in ('verified','possible','not_detected','inferred','partial','unavailable')
     or v_lp not in ('burned','locked','unlocked','protocol','team_controlled','wallet_controlled','concentrated_liquidity','partial','no_pool','open_check','insufficient_data','error','unavailable')
     or v_dev not in ('confirmed','possible_match','not_confirmed','unavailable')
     or v_observed is null
     or v_observed > now() + interval '5 minutes'
     or v_observed < now() - interval '6 hours'
     or v_input is null or jsonb_typeof(v_input) <> 'object'
  then
    return jsonb_build_object('outcome','skipped','reason','invalid_signal');
  end if;

  v_inputs := '';
  foreach v_name in array array['marketMaturity','liquiditySafety','contractSafety','behavioralRisk','marketCap','liquidity','holders','lpControl','simulation']
  loop
    v_status := v_input->>v_name;
    if v_status not in ('verified','partial','unavailable') then
      return jsonb_build_object('outcome','skipped','reason','invalid_signal');
    end if;
    v_inputs := v_inputs || case when v_inputs = '' then '' else ',' end || v_status;
  end loop;
  if (select count(*) from jsonb_object_keys(v_input)) <> 9 then
    return jsonb_build_object('outcome','skipped','reason','invalid_signal');
  end if;

  v_band := public.scan_memory_liquidity_band(v_liq);
  v_bucket := to_timestamp(floor(extract(epoch from v_observed) / 900) * 900);
  v_canonical := concat_ws(
    chr(31),
    '1', v_chain, v_token, v_scanner, v_method, v_coverage, coalesce(v_reason, '-'),
    v_score::text, coalesce(v_points::text, '-'), coalesce(v_basis, '-'), coalesce(v_band::text, '-'),
    v_honeypot, v_mint, v_blacklist, v_pause, v_lp, v_dev, v_inputs
  );
  v_hash := encode(digest(convert_to(v_canonical, 'UTF8'), 'sha256'::text), 'hex');
  if p_payload ? 'evidence_hash' and p_payload->>'evidence_hash' is distinct from v_hash then
    return jsonb_build_object('outcome','skipped','reason','invalid_signal');
  end if;

  v_signal := jsonb_build_object(
    'coverage', v_coverage,
    'coverage_reason', v_reason,
    'risk_input_statuses', v_input,
    'honeypot', jsonb_build_object('known', v_honeypot <> '-', 'is_honeypot', case v_honeypot when '1' then true when '0' then false else null end),
    'contract_flags', jsonb_build_object('mint', v_mint, 'blacklist', v_blacklist, 'pause', v_pause),
    'lp_status', v_lp,
    'dev_status', v_dev,
    'holder_points', v_points,
    'holder_basis', v_basis,
    'liquidity_band', v_band
  );

  insert into public.scan_memory_daily as daily (day, cap)
  values (v_day, 2000)
  on conflict (day) do nothing;
  select daily.cap, daily.accepted_count into v_cap, v_accepted
  from public.scan_memory_daily as daily
  where daily.day = v_day
  for update;

  if exists (select 1 from public.scan_memory where dedup_key = v_hash and observed_bucket = v_bucket) then
    update public.scan_memory
      set seen_count = seen_count + 1, last_seen_at = now()
      where dedup_key = v_hash and observed_bucket = v_bucket;
    update public.scan_memory_daily set dedup_count = dedup_count + 1 where day = v_day;
    return jsonb_build_object('outcome','deduplicated');
  end if;

  if v_accepted >= v_cap then
    update public.scan_memory_daily set capped_count = capped_count + 1 where day = v_day;
    return jsonb_build_object('outcome','capped');
  end if;

  begin
    insert into public.scan_memory (
      scanner_version, risk_methodology_version, chain, token_address, observed_at, observed_bucket,
      expires_at, coverage, coverage_reason, risk_score, risk_label, price_usd, liquidity_usd, market_cap_usd,
      liquidity_band, holder_points, holder_basis, evidence_hash, dedup_key, signal_json
    ) values (
      v_scanner, v_method, v_chain, v_token, v_observed, v_bucket,
      v_observed + interval '90 days', v_coverage, v_reason, v_score, v_label, v_price, v_liq, v_mcap,
      v_band, v_points, v_basis, v_hash, v_hash, v_signal
    );
    update public.scan_memory_daily set accepted_count = accepted_count + 1 where day = v_day;
    return jsonb_build_object('outcome','accepted');
  exception when unique_violation then
    update public.scan_memory
      set seen_count = seen_count + 1, last_seen_at = now()
      where dedup_key = v_hash and observed_bucket = v_bucket;
    update public.scan_memory_daily set dedup_count = dedup_count + 1 where day = v_day;
    return jsonb_build_object('outcome','deduplicated');
  end;
end
$$;

create or replace function public.purge_expired_scan_memory(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'purge limit must be 1..1000';
  end if;
  delete from public.scan_memory
  where id in (
    select id from public.scan_memory where expires_at < now() order by expires_at limit p_limit
  );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

alter table public.scan_memory enable row level security;
alter table public.scan_memory_daily enable row level security;

revoke all on public.scan_memory from public, anon, authenticated, service_role;
revoke all on public.scan_memory_daily from public, anon, authenticated, service_role;
grant select on public.scan_memory to service_role;
grant select on public.scan_memory_daily to service_role;

revoke all on function public.record_scan_memory(jsonb) from public, anon, authenticated;
revoke all on function public.purge_expired_scan_memory(integer) from public, anon, authenticated;
revoke all on function public.scan_memory_liquidity_band(numeric) from public, anon, authenticated;
revoke all on function public.scan_memory_immutable() from public, anon, authenticated;
grant execute on function public.record_scan_memory(jsonb) to service_role;
grant execute on function public.purge_expired_scan_memory(integer) to service_role;

commit;
