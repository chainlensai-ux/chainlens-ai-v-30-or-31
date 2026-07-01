// DEPLOYMENT LAYER — env
//
// Deployment-level environment config loading/validation for this API layer specifically (rate
// limiting, deployment tier). This is intentionally separate from — and never overrides — the
// provider-key resolution already self-contained inside providerFetchWindow/recoveryPolicy (which
// read GOLDRUSH_API_KEY/ALCHEMY_BASE_KEY etc. internally, per those modules' own existing logic).
// This file exists so the deployment layer can pre-flight-check "are provider keys configured at
// all" using the deployment's own naming convention, without ever reading or logging a key value.

export type DeploymentEnvConfig = {
  DEPLOYMENT_ENV: string
  RATE_LIMIT_MAX: number
  RATE_LIMIT_WINDOW_MS: number
  // Booleans only — never the key value itself. See getEnv()'s doc comment for why the raw value
  // is never surfaced by this module.
  goldrushKeyConfigured: boolean
  alchemyKeyConfigured: boolean
}

export const REQUIRED_ENV_KEYS = [
  'PROVIDER_API_KEY_GOLDRUSH',
  'PROVIDER_API_KEY_ALCHEMY',
  'DEPLOYMENT_ENV',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_WINDOW_MS',
] as const

const DEFAULT_RATE_LIMIT_MAX = 30
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

// Returns whether a given env key is present and non-empty — NEVER the value itself. This is the
// only sanctioned way this module touches process.env for a key that might be a secret.
function isConfigured(key: string): boolean {
  const value = process.env[key]
  return typeof value === 'string' && value.trim().length > 0
}

// Loads deployment config with safe defaults for the non-secret keys (rate limit tier). Never
// throws — an unconfigured deployment still produces a usable (conservative) config; validateEnv()
// is the strict check a caller should run before accepting production traffic.
export function loadEnv(): DeploymentEnvConfig {
  return {
    DEPLOYMENT_ENV: process.env.DEPLOYMENT_ENV ?? 'unknown',
    RATE_LIMIT_MAX: parsePositiveInt(process.env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    RATE_LIMIT_WINDOW_MS: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    goldrushKeyConfigured: isConfigured('PROVIDER_API_KEY_GOLDRUSH'),
    alchemyKeyConfigured: isConfigured('PROVIDER_API_KEY_ALCHEMY'),
  }
}

// Returns the raw string value for a NON-secret config key only (e.g. 'DEPLOYMENT_ENV',
// 'RATE_LIMIT_MAX'). Deliberately does not accept the two provider-key names — callers who need
// to know whether a provider key is configured must use loadEnv()'s boolean flags instead, never
// the raw value, so this module can never be used to exfiltrate a credential.
export function getEnv(key: Exclude<(typeof REQUIRED_ENV_KEYS)[number], 'PROVIDER_API_KEY_GOLDRUSH' | 'PROVIDER_API_KEY_ALCHEMY'>): string | undefined {
  return process.env[key]
}

export type EnvValidationResult = {
  valid: boolean
  missingKeys: string[]
}

// Reports WHICH required keys are missing by name only — never their values. A caller can use
// this as a startup/health-check gate before accepting scan requests.
export function validateEnv(): EnvValidationResult {
  const missingKeys = REQUIRED_ENV_KEYS.filter((key) => !isConfigured(key))
  return { valid: missingKeys.length === 0, missingKeys: [...missingKeys] }
}
