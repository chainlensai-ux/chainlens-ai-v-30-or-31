// Runtime deployment identity: which git commit and Vercel environment this process is serving.
// Reads exactly two Vercel system variables and returns only validated, non-secret values — never the env object
// itself, never any other variable. The commit SHA of a public repo and the environment name are not sensitive.

export type RuntimeDeploymentEnvironment = 'production' | 'preview' | 'development' | 'unknown'

export type RuntimeIdentity = {
  /** VERCEL_GIT_COMMIT_SHA when it is a well-formed git SHA; null when absent or malformed. */
  runtimeCommitSha: string | null
  /** VERCEL_ENV when it is one of Vercel's three values; null otherwise. */
  vercelEnv: 'production' | 'preview' | 'development' | null
  deploymentEnvironment: RuntimeDeploymentEnvironment
}

const SHA = /^[0-9a-f]{7,40}$/i
const VERCEL_ENVS = new Set(['production', 'preview', 'development'])

/** PURE. `env` defaults to process.env; only VERCEL_GIT_COMMIT_SHA and VERCEL_ENV are ever read. */
export function getRuntimeIdentity(env: Record<string, string | undefined> = process.env): RuntimeIdentity {
  const rawSha = env.VERCEL_GIT_COMMIT_SHA
  const rawEnv = env.VERCEL_ENV
  const runtimeCommitSha = typeof rawSha === 'string' && SHA.test(rawSha.trim()) ? rawSha.trim().toLowerCase() : null
  const vercelEnv = typeof rawEnv === 'string' && VERCEL_ENVS.has(rawEnv) ? (rawEnv as RuntimeIdentity['vercelEnv']) : null
  return { runtimeCommitSha, vercelEnv, deploymentEnvironment: vercelEnv ?? 'unknown' }
}
