-- ============================================================
-- ChainLens AI — RLS Security Migration
-- Run in Supabase SQL Editor (production + staging).
-- Safe to re-run: all drops use IF EXISTS.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- user_settings
-- ────────────────────────────────────────────────────────────
-- RLS is already enabled by supabase-user-settings.sql.
-- Problem: the existing UPDATE policy allows users to change
-- ANY column, including plan/payment fields. A user with a
-- valid JWT can self-upgrade by sending a direct Supabase
-- SDK request that bypasses /api/user-settings.
-- Fix: restrict UPDATE so plan/payment columns cannot change.
-- Service role bypasses RLS entirely, so webhook activations
-- (which use SUPABASE_SERVICE_ROLE_KEY) are unaffected.

alter table public.user_settings enable row level security;

-- SELECT — own row only (unchanged from original migration)
drop policy if exists "Users can select own settings" on public.user_settings;
create policy "Users can select own settings"
  on public.user_settings
  for select
  using (auth.uid() = user_id);

-- INSERT — own row only; plan must be 'free' and payment fields must be null.
-- Prevents a user from creating a row with plan='elite' on first sign-in.
drop policy if exists "Users can insert own settings" on public.user_settings;
create policy "Users can insert own settings"
  on public.user_settings
  for insert
  with check (
    auth.uid() = user_id
    and plan = 'free'
    and subscription_status is null
    and lemon_customer_id is null
    and lemon_subscription_id is null
    and lemon_variant_id is null
    and current_period_end is null
  );

-- UPDATE — own row only; plan and payment columns must be unchanged.
-- The WITH CHECK subqueries read the current (pre-update) stored values
-- and require the incoming values to match, blocking any elevation attempt.
-- Preference columns (theme, accent_color, etc.) are unrestricted.
drop policy if exists "Users can update own settings" on public.user_settings;
create policy "Users can update own preference fields"
  on public.user_settings
  for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    -- plan must not change
    and plan is not distinct from (
      select plan from public.user_settings where user_id = auth.uid() limit 1
    )
    -- subscription_status must not change
    and subscription_status is not distinct from (
      select subscription_status from public.user_settings where user_id = auth.uid() limit 1
    )
    -- lemon / payment reference fields must not change
    and lemon_customer_id is not distinct from (
      select lemon_customer_id from public.user_settings where user_id = auth.uid() limit 1
    )
    and lemon_subscription_id is not distinct from (
      select lemon_subscription_id from public.user_settings where user_id = auth.uid() limit 1
    )
    and lemon_variant_id is not distinct from (
      select lemon_variant_id from public.user_settings where user_id = auth.uid() limit 1
    )
    and current_period_end is not distinct from (
      select current_period_end from public.user_settings where user_id = auth.uid() limit 1
    )
  );

-- No DELETE policy for users. Service role handles any cleanup.


-- ────────────────────────────────────────────────────────────
-- affiliates
-- ────────────────────────────────────────────────────────────
-- RLS is enabled but no policies exist — deny-by-default is
-- correct. Explicit service_role policy makes intent clear and
-- prevents a future schema reset from accidentally opening access.
-- All application writes go through /api/affiliate/apply which
-- uses SUPABASE_SERVICE_ROLE_KEY.

alter table public.affiliates enable row level security;

-- Drop any accidentally created open policies
drop policy if exists "Public insert affiliates" on public.affiliates;
drop policy if exists "Public select affiliates" on public.affiliates;
drop policy if exists "Affiliates can select own row" on public.affiliates;
drop policy if exists "Users can insert affiliates" on public.affiliates;
drop policy if exists "affiliates_service_role_all" on public.affiliates;

-- Service role has full access (bypasses RLS anyway, but explicit is safer)
create policy "affiliates_service_role_all"
  on public.affiliates
  for all
  to service_role
  using (true)
  with check (true);

-- No authenticated user policies:
-- - payout_wallet, email, commission_rate must not be publicly readable
-- - affiliate applications go through the API only


-- ────────────────────────────────────────────────────────────
-- affiliate_commissions
-- ────────────────────────────────────────────────────────────
-- Service role only. Commissions are created exclusively by the
-- NOWPayments IPN webhook. No user should read or write these
-- rows directly — a future affiliate dashboard should use a
-- server route with service role to return only the affiliate's
-- own commissions.

alter table public.affiliate_commissions enable row level security;

drop policy if exists "Public insert commissions" on public.affiliate_commissions;
drop policy if exists "Public select commissions" on public.affiliate_commissions;
drop policy if exists "Users can select own commissions" on public.affiliate_commissions;
drop policy if exists "affiliate_commissions_service_role_all" on public.affiliate_commissions;

create policy "affiliate_commissions_service_role_all"
  on public.affiliate_commissions
  for all
  to service_role
  using (true)
  with check (true);


-- ────────────────────────────────────────────────────────────
-- crypto_payments
-- ────────────────────────────────────────────────────────────
-- RLS enabled, no policies — deny-by-default is correct for
-- writes. Users may read their own payment rows (useful for
-- showing payment status on the pricing page). All inserts and
-- updates come from server routes using service role.

alter table public.crypto_payments enable row level security;

drop policy if exists "Public insert crypto_payments" on public.crypto_payments;
drop policy if exists "Users can insert crypto_payments" on public.crypto_payments;
drop policy if exists "Users can update crypto_payments" on public.crypto_payments;
drop policy if exists "Users can select own payments" on public.crypto_payments;
drop policy if exists "crypto_payments_service_role_all" on public.crypto_payments;

-- Users may read their own payment rows only
create policy "Users can select own payments"
  on public.crypto_payments
  for select
  using (auth.uid() = user_id);

-- Service role has full access for checkout and IPN webhook
create policy "crypto_payments_service_role_all"
  on public.crypto_payments
  for all
  to service_role
  using (true)
  with check (true);

-- No user insert/update/delete policies — all writes are server-side only
