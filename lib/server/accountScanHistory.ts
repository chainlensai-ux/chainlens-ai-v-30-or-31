import { createClient } from '@supabase/supabase-js'
import { recordedFactors } from './scanMemory/historyFactors'
import { createHmac, timingSafeEqual } from 'node:crypto'

export const ACCOUNT_SCAN_CHAINS: Record<string, number> = { eth: 1, base: 8453, bnb: 56, robinhood: 4663, solana: 101 }
export function canonicalHistoryToken(chain: string, token: string): string | null {
  if (chain === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token) ? token : null
  return ACCOUNT_SCAN_CHAINS[chain] && /^0x[0-9a-f]{40}$/i.test(token) ? token.toLowerCase() : null
}
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
export type AccountScanRow = {
  user_id: string; chain_id: number; chain: string; token_address: string; scan_request_id: string
  observed_at: string; scanner_version: string; risk_methodology_version: string
  risk_score: number | null; risk_label: string; confidence: string; coverage_percent: number
  evidence_snapshot: Record<string, unknown>
}
export function accountScanRow(userId: string, scan: Record<string, any>): AccountScanRow | null {
  const chain = typeof scan.chain === 'string' ? scan.chain : ''
  const token = canonicalHistoryToken(chain, String(scan.contract ?? ''))
  const id = scan.scanRequestId
  const time = finite(scan.scanRequestStartedAt)
  const score = finite(scan.riskScore)
  const coverage = finite(scan.riskEvidenceCoveragePercent)
  const confidence = scan.riskEngine?.confidence
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !token || typeof id !== 'string' || !/^[a-z0-9_-]{1,160}$/i.test(id)
    || time == null || time < 0 || time > 8.64e15 || coverage == null || coverage < 0 || coverage > 100
    || !['high', 'medium', 'low'].includes(confidence) || (scan.riskScore != null && (score == null || !Number.isInteger(score) || score < 0 || score > 100))
    || typeof scan.riskMethodologyVersion !== 'string' || !/^[a-z0-9_:.\-]{1,100}$/i.test(scan.riskMethodologyVersion)) return null
  const evidence = Array.isArray(scan.scoreEvidence) ? scan.scoreEvidence : []
  const adjustments = Array.isArray(scan.scoreAdjustments) ? scan.scoreAdjustments : []
  if (evidence.length > 30 || adjustments.length > 5) return null
  if (evidence.some((e: any) => typeof e?.input !== 'string' || !/^[a-zA-Z]{1,40}$/.test(e.input)
    || finite(e.safetyPoints) == null || finite(e.maxPoints) == null || e.maxPoints <= 0 || e.safetyPoints < 0 || e.safetyPoints > e.maxPoints)) return null
  if (adjustments.some((a: any) => !['confirmed_honeypot', 'verified_mint_blacklist_pause'].includes(a?.reason)
    || finite(a.safetyBefore) == null || finite(a.safetyAfter) == null || a.safetyAfter < 0 || a.safetyAfter > a.safetyBefore || a.safetyBefore > 100)) return null
  if (chain !== 'solana' && score != null) {
    const max = evidence.reduce((n: number, e: any) => n + e.maxPoints, 0)
    if (Math.round(max) !== coverage || max > 100.000001 || new Set(evidence.map((e: any) => e.input)).size !== evidence.length) return null
    let safety = max ? Math.round(100 * evidence.reduce((n: number, e: any) => n + e.safetyPoints, 0) / max) : null
    for (const a of adjustments) { if (a.safetyBefore !== safety) return null; safety = a.safetyAfter }
    if (safety == null || score !== 100 - safety) return null
  }
  return {
    user_id: userId, chain_id: ACCOUNT_SCAN_CHAINS[chain], chain, token_address: token, scan_request_id: id,
    observed_at: new Date(time).toISOString(), scanner_version: `token_scanner_response:${scan.scanResponseSchemaVersion ?? 'solana'}`,
    risk_methodology_version: scan.riskMethodologyVersion, risk_score: score,
    risk_label: score == null ? 'Unrated' : String(scan.riskLabel ?? 'Unrated').slice(0, 40), confidence, coverage_percent: coverage,
    evidence_snapshot: {
      scoreEvidence: evidence.map((e: any) => ({ input: e.input, safetyPoints: e.safetyPoints, maxPoints: e.maxPoints })),
      scoreAdjustments: adjustments.map((a: any) => ({ reason: a.reason, safetyBefore: a.safetyBefore, safetyAfter: a.safetyAfter })),
      factors: recordedFactors({ contract_flags: scan.contractFlags, honeypot: { is_honeypot: scan.honeypot?.isHoneypot }, lp_status: scan.lpControl?.status, dev_status: scan.riskEngine?.deployerProfile?.status }),
      priceUsd: finite(scan.priceUsd), liquidityUsd: finite(scan.liquidityUsd ?? scan.liquidity), marketCapUsd: finite(scan.marketCapUsd),
      top10: finite(scan.holderDistribution?.top10), holderBasis: typeof scan.holderDistribution?.denominator === 'string' ? scan.holderDistribution.denominator.slice(0, 120) : null,
      solanaAuthorities: chain === 'solana' ? {
        readSucceeded: scan.solanaAuthorities?.readSucceeded === true,
        mintAuthority: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(scan.solanaAuthorities?.mintAuthority ?? '') ? scan.solanaAuthorities.mintAuthority : null,
        freezeAuthority: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(scan.solanaAuthorities?.freezeAuthority ?? '') ? scan.solanaAuthorities.freezeAuthority : null,
      } : null,
      lpProof: scan.concentratedPositionProof ? {
        model: String(scan.concentratedPositionProof.poolModel ?? 'unknown').slice(0, 40),
        status: String(scan.concentratedPositionProof.ownershipStatus ?? 'ownership_open_check').slice(0, 60),
        pool: /^0x[0-9a-f]{40}([0-9a-f]{24})?$/i.test(scan.concentratedPositionProof.poolAddress ?? scan.concentratedPositionProof.poolId ?? '') ? scan.concentratedPositionProof.poolAddress ?? scan.concentratedPositionProof.poolId : null,
        topOwner: /^0x[0-9a-f]{40}$/i.test(scan.concentratedPositionProof.topPositionOwner ?? '') ? scan.concentratedPositionProof.topPositionOwner : null,
        topShare: finite(scan.concentratedPositionProof.topPositionSharePercent),
      } : null,
    },
  }
}

export type AccountHistoryReceipt = { status: 'saved' | 'duplicate' | 'unavailable' | 'ineligible'; observedAt: string | null; retryToken?: string }
type Save = (row: AccountScanRow) => Promise<{ observedAt: string; duplicate: boolean }>
function retrySignature(body: string): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return key ? createHmac('sha256', key).update('cortex-account-history-retry:v1:' + body).digest('hex') : null
}
function retryToken(row: AccountScanRow): string | undefined {
  const body = Buffer.from(JSON.stringify({ row, issuedAt: Date.now() })).toString('base64url')
  const signature = retrySignature(body)
  return signature ? `${body}.${signature}` : undefined
}
async function saveRow(row: AccountScanRow) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('history_unconfigured')
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const conflict = 'user_id,chain_id,token_address,scan_request_id'
  const { data, error } = await db.from('cortex_account_scan_history').upsert(row, { onConflict: conflict, ignoreDuplicates: true }).select('observed_at').abortSignal(AbortSignal.timeout(1500)).maybeSingle()
  if (error) throw new Error('history_write_failed')
  if (data) return { observedAt: data.observed_at as string, duplicate: false }
  const existing = await db.from('cortex_account_scan_history').select('observed_at').eq('user_id', row.user_id).eq('chain_id', row.chain_id).eq('token_address', row.token_address).eq('scan_request_id', row.scan_request_id).abortSignal(AbortSignal.timeout(1500)).single()
  if (existing.error || !existing.data) throw new Error('history_confirmation_failed')
  return { observedAt: existing.data.observed_at as string, duplicate: true }
}
export async function persistAccountScan(userId: string, scan: Record<string, any>, save: Save = saveRow): Promise<AccountHistoryReceipt> {
  const row = accountScanRow(userId, scan)
  if (!row) return { status: 'ineligible', observedAt: null }
  try {
    const result = await save(row)
    return { status: result.duplicate ? 'duplicate' : 'saved', observedAt: result.observedAt }
  } catch { return { status: 'unavailable', observedAt: null, retryToken: retryToken(row) } }
}

/** Retry only a server-signed completed observation; never trust client-supplied score/evidence. */
export async function retryAccountScan(userId: string, token: unknown, save: Save = saveRow): Promise<AccountHistoryReceipt> {
  if (typeof token !== 'string' || token.length > 20_000) return { status: 'ineligible', observedAt: null }
  const [body, signature, extra] = token.split('.')
  const expected = retrySignature(body)
  if (extra || !expected || !/^[a-f0-9]{64}$/.test(signature ?? '') || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return { status: 'ineligible', observedAt: null }
  try {
    const { row, issuedAt } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { row: AccountScanRow; issuedAt: number }
    if (row.user_id !== userId || !Number.isFinite(issuedAt) || issuedAt > Date.now() || Date.now() - issuedAt > 86_400_000) return { status: 'ineligible', observedAt: null }
    const result = await save(row)
    return { status: result.duplicate ? 'duplicate' : 'saved', observedAt: result.observedAt }
  } catch { return { status: 'unavailable', observedAt: null, retryToken: token } }
}
