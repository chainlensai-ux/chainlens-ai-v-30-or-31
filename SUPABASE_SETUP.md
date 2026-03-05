# ChainLens AI v30 — Supabase Setup Guide

## What Supabase gives you
- Real accounts that work across all devices
- GhostTrade portfolio persists forever
- TradeCoach journal syncs across devices
- ProofVault predictions stored server-side
- Price alerts survive browser clears
- Saved wallets sync everywhere
- Real GlobalRank leaderboard (auto-updated via DB trigger)
- Plan is stored server-side — localStorage tampering does nothing

---

## Step 1 — Create your Supabase project

1. Go to https://supabase.com and sign up (free)
2. Click "New Project"
3. Name it: `chainlens-ai`
4. Set a strong database password (save it)
5. Choose region closest to your users (Australia → Singapore or Sydney)
6. Wait ~2 minutes for project to spin up

---

## Step 2 — Run the database schema

1. In your Supabase dashboard, click **SQL Editor** in the left sidebar
2. Click **New Query**
3. Open `supabase-schema.sql` from this zip
4. Paste the entire contents into the editor
5. Click **Run** (green button)
6. You should see "Success. No rows returned."

This creates all 8 tables with row-level security enabled.

---

## Step 3 — Get your API keys

In your Supabase dashboard:
1. Click **Settings** (gear icon, bottom left)
2. Click **API**
3. Copy two values:
   - **Project URL** → looks like `https://abcdefgh.supabase.co`
   - **service_role key** → under "Project API keys" → secret key (NOT the anon key)

⚠️ The service_role key has full database access — never expose it client-side. It only lives in Vercel env vars.

---

## Step 4 — Add env vars to Vercel

In your Vercel dashboard:
1. Go to your ChainLens project
2. Click **Settings** → **Environment Variables**
3. Add these (in addition to existing ones):

| Name | Value |
|------|-------|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJ...` (service_role key) |
| `ANTHROPIC_API_KEY` | (already set) |
| `ETHERSCAN_API_KEY` | (already set) |

4. Click **Save** for each
5. Go to **Deployments** → click the three dots on latest deploy → **Redeploy**

---

## Step 5 — Test it

1. Open your live Vercel URL
2. Sign up for a new account
3. Place a GhostTrade
4. Open an incognito window, log in with the same account
5. Your GhostTrade should be there ✅

---

## What still uses localStorage (by design)

These are fine to stay local — they're UI preferences, not user data:
- `cl_ob_done` — onboarding seen flag
- `cl_pwa_dismissed` — install banner dismissed
- Smart Wallets custom list (non-sensitive, device preference)

---

## Stripe integration (next step after Supabase)

When you add Stripe, the webhook will call:
```
POST /api/auth
{ action: 'updatePlan', userId: '...', plan: 'pro' }
```

This updates the `profiles` table. Next time the user loads the app, `initAuth` fetches their fresh plan from Supabase and updates the UI automatically.
