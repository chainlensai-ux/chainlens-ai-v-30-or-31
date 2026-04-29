create extension if not exists pgcrypto;

create table if not exists public.affiliate_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  telegram text,
  x_handle text,
  audience_size text,
  audience_type text,
  promotion_plan text,
  wallet_address text,
  status text not null default 'new',
  source text not null default 'affiliate_page',
  user_agent text,
  ip_hash text
);

create index if not exists affiliate_applications_created_at_idx on public.affiliate_applications(created_at desc);
create index if not exists affiliate_applications_email_idx on public.affiliate_applications(email);
create index if not exists affiliate_applications_status_idx on public.affiliate_applications(status);

alter table public.affiliate_applications enable row level security;

revoke all on public.affiliate_applications from anon;
revoke all on public.affiliate_applications from authenticated;

-- server-side service role bypasses RLS; no public read/update/delete policies are added.
create policy "service role insert affiliate applications"
  on public.affiliate_applications
  for insert
  to service_role
  with check (true);
