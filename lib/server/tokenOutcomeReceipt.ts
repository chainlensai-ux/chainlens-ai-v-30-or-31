import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import { canTrackOutcome, numberOrNull, type ScanSnapshot } from '../tokenOutcomes'

function secret() { return process.env.TOKEN_OUTCOME_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY }
export function snapshotFromScan(scan: Record<string, unknown>, userId: string): ScanSnapshot | null {
  if (scan.riskScoreType !== 'risk_score' || scan.riskScoreDirection !== 'higher_is_riskier' || !canTrackOutcome(scan.riskScore)) return null
  const chain = String(scan.chain ?? '')
  const address = String(scan.contract ?? '')
  if (!['eth', 'base', 'bnb', 'robinhood', 'solana'].includes(chain) || !(chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[\da-f]{40}$/i).test(address)) return null
  // Copy only public, canonical sections AFTER the existing plan gate. Never include provider debug payloads.
  return JSON.parse(JSON.stringify({
    userId, chain, tokenAddress: chain === 'solana' ? address : address.toLowerCase(),
    tokenSymbol: scan.symbol ?? '', tokenName: scan.name ?? '',
    scanId: scan.scanRequestId || randomUUID(), scannedAt: new Date(typeof scan.scanRequestStartedAt === 'number' ? scan.scanRequestStartedAt : Date.now()).toISOString(),
    baselinePriceUsd: numberOrNull(scan.priceUsd), baselineLiquidityUsd: numberOrNull(scan.liquidityUsd),
    baselineMarketCapUsd: numberOrNull(scan.marketCapUsd), baselineRiskScore: scan.riskScore,
    baselineVerdict: scan.riskLabel ?? scan.cortexVerdict ?? 'Verdict not recorded',
    baselineRiskReasons: scan.riskBreakdown ?? scan.scoreReasons ?? null,
    baselineSecuritySignals: { security: scan.security ?? null, honeypot: scan.honeypot ?? null, contractSecurity: scan.contractSecurity ?? null },
    baselineLpSignals: { lpControl: scan.lpControl ?? null, model: scan.lpModelProof ?? null, proof: scan.lpProofStatus ?? null },
    baselineHolderSignals: scan.holderDistribution ?? null, baselineDevSignals: scan.devIntel ?? null,
    baselineOwnershipSignals: scan.contractFlags ?? null,
    baselineMarketQualitySignals: { inputs: scan.riskInputsUsed ?? null, priceSource: scan.priceSource ?? null, marketCapSource: scan.marketCapSource ?? null },
  })) as ScanSnapshot
}
export function signOutcomeSnapshot(snapshot: ScanSnapshot): string | null {
  const key = secret()
  if (!key) return null
  const payload = Buffer.from(JSON.stringify({ version: 1, snapshot })).toString('base64url')
  if (payload.length > 180_000) return null
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
}
export function verifyOutcomeReceipt(receipt: unknown, userId: string): ScanSnapshot | null {
  const key = secret()
  if (!key || typeof receipt !== 'string' || receipt.length > 181_000) return null
  try {
    const parts = receipt.split('.')
    if (parts.length !== 2) return null
    const expected = createHmac('sha256', key).update(parts[0]).digest()
    const supplied = Buffer.from(parts[1], 'base64url')
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null
    const { version, snapshot } = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    if (version !== 1 || snapshot.userId !== userId || !canTrackOutcome(snapshot.baselineRiskScore)) return null
    return snapshot
  } catch { return null }
}
export function withOutcomeReceipt<T extends Record<string, unknown>>(scan: T, userId: string): T & { outcomeReceipt: string | null } {
  // Signing availability must not break a scan. No signed receipt is ever stored in the shared scanner cache.
  try { const snapshot = snapshotFromScan(scan, userId); return { ...scan, outcomeReceipt: snapshot ? signOutcomeSnapshot(snapshot) : null } }
  catch { return { ...scan, outcomeReceipt: null } }
}
