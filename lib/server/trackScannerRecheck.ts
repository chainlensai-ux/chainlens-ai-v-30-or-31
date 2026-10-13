// TRACK SCANNER RECHECK — the "Scan vs Now" current Risk Score / Top 10 / Dev Wallet values.
//
// Before: the current scanner values were only ever read from the shared token-scan cache (45s TTL) when some
// other request had happened to scan the same token after the baseline, and never for Solana — so they were
// "Current unavailable" for almost every receipt. Now a Track refresh whose scanner evidence is stale runs the
// SAME real Token Scanner (POST /api/token) for that token as the signed-in user. A tracked-token recheck must
// not spend the user's token-scan credits, so the request carries an HMAC (server-only Track signing secret)
// bound to user + chain + token + minute; /api/token verifies it and skips only the quota debit (auth and the
// rate limiter still apply). No secret configured → no recheck (values stay honestly unavailable).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { outcomeSigningSecret } from './tokenOutcomeReceipt'
import { computeSolanaCortexRisk } from '../solanaCortexRisk'
import type { SolanaBetaScanResult } from './solana/types'

export const TRACK_RECHECK_HEADER = 'x-chainlens-track-recheck'
export const SOLANA_RISK_METHODOLOGY_VERSION = 'solana_cortex_risk:v1'
/** Solana top-N is the share of total supply held by the largest token ACCOUNTS (never "holders"). */
export const SOLANA_HOLDER_BASIS = 'solana:largest_token_accounts/total_supply'
const WINDOW_MS = 60_000

const normToken = (chain: string, token: string) => (chain === 'solana' ? token : token.toLowerCase())
function mac(key: string, userId: string, chain: string, token: string, bucket: number): Buffer {
  return createHmac('sha256', key).update(`track-recheck:v1:${userId}:${chain}:${normToken(chain, token)}:${bucket}`).digest()
}

export function signTrackRecheck(userId: string, chain: string, token: string, now = Date.now(), key = outcomeSigningSecret()): string | null {
  return key ? mac(key, userId, chain, token, Math.floor(now / WINDOW_MS)).toString('base64url') : null
}

/** Valid for the current or previous minute only, for exactly this user + chain + token. */
export function verifyTrackRecheck(sig: string | null, userId: string, chain: unknown, token: unknown, now = Date.now(), key = outcomeSigningSecret()): boolean {
  if (!key || !sig || typeof chain !== 'string' || typeof token !== 'string' || sig.length > 100) return false
  const supplied = Buffer.from(sig, 'base64url')
  const bucket = Math.floor(now / WINDOW_MS)
  return [bucket, bucket - 1].some((b) => {
    const expected = mac(key, userId, chain, token.trim(), b)
    return expected.length === supplied.length && timingSafeEqual(expected, supplied)
  })
}

/** Solana scanner result → the scan fields Track reads (same canonical risk read the Solana receipt uses). */
export function solanaScanForTrack(scan: SolanaBetaScanResult, startedAt: number): Record<string, unknown> {
  // A risk read that cannot be computed from this result leaves Risk unavailable; Top 10 still stands.
  let riskScore: number | null = null
  try { riskScore = computeSolanaCortexRisk(scan).riskScore } catch { riskScore = null }
  const top10 = scan.topAccountConcentration?.top10Percent
  return {
    chain: 'solana', contract: scan.mintAddress, scanRequestStartedAt: startedAt,
    riskScore, riskScoreType: riskScore != null ? 'risk_score' : null, riskScoreDirection: 'higher_is_riskier',
    riskMethodologyVersion: SOLANA_RISK_METHODOLOGY_VERSION,
    holderDistribution: { top10: typeof top10 === 'number' ? top10 : null, denominator: typeof top10 === 'number' ? SOLANA_HOLDER_BASIS : null },
    devIntel: null,
  }
}

export type TrackScannerRecheck = (row: { chain: string; token_address: string }) => Promise<Record<string, unknown> | null>

/** Runs the real Token Scanner for one tracked token as `authorization`'s user. Null on any failure. */
export function trackScannerRecheck(params: {
  origin: string; authorization: string | null; userId: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number
}): TrackScannerRecheck {
  const fetchImpl = params.fetchImpl ?? fetch
  const now = params.now ?? Date.now
  return async (row) => {
    const startedAt = now()
    const sig = signTrackRecheck(params.userId, row.chain, row.token_address, startedAt)
    if (!sig || !params.authorization) return null
    try {
      const res = await fetchImpl(`${params.origin}/api/token`, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(params.timeoutMs ?? 25_000),
        headers: { 'Content-Type': 'application/json', Authorization: params.authorization, [TRACK_RECHECK_HEADER]: sig },
        body: JSON.stringify({ contract: row.token_address, chain: row.chain }),
      })
      if (!res.ok) return null
      const json = await res.json() as Record<string, unknown>
      if (!json || json.error) return null
      if (row.chain === 'solana') {
        return json.mintAddress === row.token_address ? solanaScanForTrack(json as unknown as SolanaBetaScanResult, startedAt) : null
      }
      if (json.chain !== row.chain || typeof json.contract !== 'string' || json.contract.toLowerCase() !== row.token_address.toLowerCase()) return null
      return { ...json, scanRequestStartedAt: startedAt }
    } catch {
      return null
    }
  }
}
