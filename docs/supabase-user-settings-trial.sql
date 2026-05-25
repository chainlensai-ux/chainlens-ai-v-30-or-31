-- 7-day Elite pass claim fields
ALTER TABLE IF EXISTS public.user_settings
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS trial_plan text NULL DEFAULT 'elite',
  ADD COLUMN IF NOT EXISTS trial_used boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS trial_granted_reason text NULL;

UPDATE public.user_settings
SET trial_used = false
WHERE trial_used IS NULL;
