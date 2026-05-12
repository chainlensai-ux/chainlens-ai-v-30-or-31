create extension if not exists pgcrypto;

create table if not exists public.affiliate_applications (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  telegram text,
  x_handle text not null,
  audience_size text not null,
  audience_type text not null,
  payout_wallet text,
  promo_plan text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists affiliate_applications_created_at_idx on public.affiliate_applications(created_at desc);
create index if not exists affiliate_applications_status_idx on public.affiliate_applications(status);

alter table public.affiliate_applications enable row level security;

-- API writes with SUPABASE_SERVICE_ROLE_KEY, so no public insert policy is required.
