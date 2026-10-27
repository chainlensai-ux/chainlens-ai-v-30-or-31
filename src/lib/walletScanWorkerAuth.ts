// Internal call from the scan trigger / watchdog to POST /api/wallet-scan/worker, and the worker
// route's check of it — one module so the target URL, the headers sent and the headers checked can
// never drift apart.
//
// TARGET: a stable domain, not the per-deployment VERCEL_URL. Deployment URLs sit behind Vercel
// Deployment Protection (a 401 from Vercel's edge before our route ever runs), production/alias
// domains normally do not. Order: WALLET_SCAN_WORKER_BASE_URL (explicit) → production domain
// (VERCEL_PROJECT_PRODUCTION_URL, production only) → branch alias (VERCEL_BRANCH_URL) → VERCEL_URL →
// localhost. If the chosen host is protected anyway, VERCEL_AUTOMATION_BYPASS_SECRET is sent as
// x-vercel-protection-bypass.
//
// AUTH: the shared WALLET_SCAN_WORKER_SECRET (whitespace-trimmed on both sides) is sent in two headers —
// `Authorization: Bearer …` and `x-wallet-scan-worker-secret` — and the route accepts either, compared
// in constant time. A rejection carries a reason code (never a secret).
import { timingSafeEqual } from 'node:crypto'

export const WORKER_SECRET_HEADER = 'x-wallet-scan-worker-secret'
export const VERCEL_BYPASS_HEADER = 'x-vercel-protection-bypass'
export const WORKER_PATH = '/api/wallet-scan/worker'

type Env = Record<string, string | undefined>

export type WorkerTarget = {
  url: string
  host: string
  source: 'WALLET_SCAN_WORKER_BASE_URL' | 'VERCEL_PROJECT_PRODUCTION_URL' | 'VERCEL_BRANCH_URL' | 'VERCEL_URL' | 'localhost'
}

const clean = (v: string | undefined) => (v ?? '').trim()
const withScheme = (hostOrUrl: string) => (/^https?:\/\//i.test(hostOrUrl) ? hostOrUrl : `https://${hostOrUrl}`).replace(/\/+$/, '')

export function resolveWorkerTarget(env: Env = process.env): WorkerTarget {
  const pick = (base: string, source: WorkerTarget['source']): WorkerTarget => {
    const url = `${withScheme(base)}${WORKER_PATH}`
    return { url, host: new URL(url).host, source }
  }
  if (clean(env.WALLET_SCAN_WORKER_BASE_URL)) return pick(clean(env.WALLET_SCAN_WORKER_BASE_URL), 'WALLET_SCAN_WORKER_BASE_URL')
  if (clean(env.VERCEL_ENV) === 'production' && clean(env.VERCEL_PROJECT_PRODUCTION_URL)) return pick(clean(env.VERCEL_PROJECT_PRODUCTION_URL), 'VERCEL_PROJECT_PRODUCTION_URL')
  if (clean(env.VERCEL_BRANCH_URL)) return pick(clean(env.VERCEL_BRANCH_URL), 'VERCEL_BRANCH_URL')
  if (clean(env.VERCEL_URL)) return pick(clean(env.VERCEL_URL), 'VERCEL_URL')
  return { url: `http://localhost:3000${WORKER_PATH}`, host: 'localhost:3000', source: 'localhost' }
}

export function workerSecret(env: Env = process.env): string | null {
  return clean(env.WALLET_SCAN_WORKER_SECRET) || null
}

/** Headers for the internal worker call; null when the shared secret is not configured. */
export function workerRequestHeaders(env: Env = process.env): Record<string, string> | null {
  const secret = workerSecret(env)
  if (!secret) return null
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${secret}`,
    [WORKER_SECRET_HEADER]: secret,
  }
  const bypass = clean(env.VERCEL_AUTOMATION_BYPASS_SECRET)
  if (bypass) headers[VERCEL_BYPASS_HEADER] = bypass
  return headers
}

export type WorkerAuthResult = { ok: true } | { ok: false; reason: 'secret_not_configured' | 'missing_credentials' | 'secret_mismatch' }

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function isAuthorizedWalletScanWorkerRequest(req: Request, env: Env = process.env): boolean {
  return checkWorkerRequest(req, env).ok
}

export function checkWorkerRequest(req: Request, env: Env = process.env): WorkerAuthResult {
  const secret = workerSecret(env)
  if (!secret) return { ok: false, reason: 'secret_not_configured' }
  const authorization = req.headers.get('authorization') ?? ''
  const bearer = /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, '').trim() : ''
  const custom = (req.headers.get(WORKER_SECRET_HEADER) ?? '').trim()
  if (!bearer && !custom) return { ok: false, reason: 'missing_credentials' }
  if ((bearer && sameSecret(bearer, secret)) || (custom && sameSecret(custom, secret))) return { ok: true }
  return { ok: false, reason: 'secret_mismatch' }
}
