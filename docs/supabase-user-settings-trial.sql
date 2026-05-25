-- 7-day Elite pass claim fields (idempotent)
ALTER TABLE IF EXISTS public.user_settings
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS trial_plan text NULL DEFAULT 'elite',
  ADD COLUMN IF NOT EXISTS trial_used boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS trial_granted_reason text NULL,
  ADD COLUMN IF NOT EXISTS trial_email_hash text NULL,
  ADD COLUMN IF NOT EXISTS trial_claim_ip_hash text NULL,
  ADD COLUMN IF NOT EXISTS trial_claim_user_agent_hash text NULL;

UPDATE public.user_settings
SET trial_used = false
WHERE trial_used IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_settings_trial_email_hash
  ON public.user_settings (trial_email_hash);

CREATE INDEX IF NOT EXISTS idx_user_settings_trial_ends_at
  ON public.user_settings (trial_ends_at);

CREATE INDEX IF NOT EXISTS idx_user_settings_trial_used
  ON public.user_settings (trial_used);

CREATE INDEX IF NOT EXISTS idx_user_settings_trial_claim_ip_hash_started_at
  ON public.user_settings (trial_claim_ip_hash, trial_started_at);
