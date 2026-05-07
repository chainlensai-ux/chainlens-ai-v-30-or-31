-- ChainLens subscription plan sync
-- Run in Supabase SQL editor AFTER supabase-user-settings.sql
-- Adds plan + Lemon Squeezy fields to the existing user_settings table.
--
-- Required env vars (server-side only):
--   SUPABASE_SERVICE_ROLE_KEY  — used by webhook and server helpers
--   LEMONSQUEEZY_WEBHOOK_SECRET — used to verify X-Signature header
--   LEMONSQUEEZY_PRO_VARIANT_ID — variant_id from Lemon Squeezy for Pro
--   LEMONSQUEEZY_ELITE_VARIANT_ID — variant_id from Lemon Squeezy for Elite
--
-- Client-side (safe to expose):
--   NEXT_PUBLIC_SUPABASE_URL
--   NEXT_PUBLIC_SUPABASE_ANON_KEY

alter table public.user_settings
  add column if not exists plan text not null default 'free',
  add column if not exists theme text not null default 'dark',
  add column if not exists accent_color text not null default 'mint',
  add column if not exists compact_mode boolean not null default false,
  add column if not exists email_notifications boolean not null default true,
  add column if not exists push_notifications boolean not null default false,
  add column if not exists whale_alert_threshold numeric not null default 10000,
  add column if not exists default_chain text not null default 'base',
  add column if not exists lemon_customer_id text,
  add column if not exists lemon_subscription_id text,
  add column if not exists lemon_variant_id text,
  add column if not exists subscription_status text,
  add column if not exists current_period_end timestamptz,
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'user_settings'
      and constraint_type = 'PRIMARY KEY'
  ) then
    alter table public.user_settings add primary key (user_id);
  end if;
end $$;

-- Index for quick email-based webhook lookups via service role.
-- (lookups go through auth.users → user_id join, so this index helps secondary look)
create index if not exists user_settings_plan_idx on public.user_settings(plan);

-- The service role bypasses RLS, so no additional policy is needed for webhook writes.
-- Users can READ their own plan (already covered by existing RLS select policy).

-- ─── Server-side email → user_id lookup (used by webhook helper) ────────────
-- Required because Supabase JS SDK admin API does not expose getUserByEmail.
-- SECURITY DEFINER so the service role can query auth.users safely.
create or replace function public.get_user_id_by_email(lookup_email text)
returns uuid
language sql
security definer
set search_path = auth
as $$
  select id from users where email = lookup_email limit 1;
$$;

-- ─── Manual plan override for local / QA testing ─────────────────────────────
-- Run as service role in Supabase SQL editor:
--
--   UPDATE public.user_settings
--   SET plan = 'pro',          -- or 'elite' or 'free'
--       updated_at = now()
--   WHERE user_id = (
--     SELECT id FROM auth.users WHERE email = 'your@email.com'
--   );
--
-- This is the ONLY safe way to manually set a plan in production.
-- Do NOT expose a UI for this outside of a properly auth-gated admin route.
