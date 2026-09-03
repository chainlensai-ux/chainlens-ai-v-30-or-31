-- ============================================================
-- ChainLens AI — Legacy `public.profiles` lockdown
-- Run in Supabase SQL Editor (production + staging), IF this table
-- still exists in the live project. Safe to re-run: all drops use
-- IF EXISTS, and the DO block below no-ops entirely when the table
-- is absent.
-- ============================================================
--
-- AUDIT FINDING (auth hardening audit): supabase-schema.sql (repo root) defines a
-- `public.profiles` table from an earlier product iteration (columns like
-- stripe_customer_id/ghost_trades/proofvault do not match the current PayPal/Lemon
-- billing code) with:
--   create policy "profiles_own" on public.profiles for all using (auth.uid() = id);
-- This is a FOR ALL policy with no WITH CHECK restricting which columns can change —
-- a signed-in user with a valid JWT could call the Supabase REST/JS SDK directly and
-- run `update profiles set plan = 'elite' where id = auth.uid()`, self-upgrading their
-- plan. A repo-wide search confirms current app code never reads/writes this table
-- (the live plan/subscription table is public.user_settings, already locked down by
-- supabase-rls-security.sql) — but if `profiles` still exists in the live database,
-- its permissive policy is a real, live self-upgrade vulnerability regardless of
-- whether the app itself calls it, since any authenticated client can hit the
-- Supabase REST API directly with its own anon-key + JWT.
--
-- FIX: replace the single FOR ALL policy with column-restricted SELECT/INSERT/UPDATE
-- policies mirroring user_settings' pattern (plan is a plain text column here rather
-- than a fixed set of payment columns, so the fix locks `plan` specifically). No
-- DELETE policy is added — none existed before either. Service role (used by any
-- future webhook activation) bypasses RLS entirely and is unaffected.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise notice 'public.profiles does not exist in this database — nothing to lock down.';
    return;
  end if;

  alter table public.profiles enable row level security;

  execute 'drop policy if exists "profiles_own" on public.profiles';

  -- SELECT — own row only.
  execute 'drop policy if exists "profiles_select_own" on public.profiles';
  execute $q$
    create policy "profiles_select_own"
      on public.profiles
      for select
      using (auth.uid() = id)
  $q$;

  -- INSERT — own row only; plan must be 'free' on first insert.
  execute 'drop policy if exists "profiles_insert_own" on public.profiles';
  execute $q$
    create policy "profiles_insert_own"
      on public.profiles
      for insert
      with check (auth.uid() = id and plan = 'free')
  $q$;

  -- UPDATE — own row only; plan (and the Stripe subscription reference columns, which
  -- only a trusted payment/webhook path should ever set) must stay unchanged.
  execute 'drop policy if exists "profiles_update_own" on public.profiles';
  execute $q$
    create policy "profiles_update_own"
      on public.profiles
      for update
      using (auth.uid() = id)
      with check (
        auth.uid() = id
        and plan is not distinct from (select plan from public.profiles where id = auth.uid() limit 1)
        and stripe_customer_id is not distinct from (select stripe_customer_id from public.profiles where id = auth.uid() limit 1)
        and stripe_subscription_id is not distinct from (select stripe_subscription_id from public.profiles where id = auth.uid() limit 1)
      )
  $q$;

  raise notice 'public.profiles RLS locked down — plan/stripe columns can no longer be self-updated.';
end $$;
