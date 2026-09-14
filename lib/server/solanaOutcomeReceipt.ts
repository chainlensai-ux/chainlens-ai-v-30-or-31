import type { SolanaBetaScanResult } from './solanaTokenScannerBeta'
import { computeSolanaCortexRisk } from '../solanaCortexRisk'
import { signOutcomeSnapshot, snapshotFromScan } from './tokenOutcomeReceipt'

export function solanaOutcomeReceipt(scan: SolanaBetaScanResult, userId: string, scanId: string, startedAt: number): string | null {
  try {
    // Same canonical read already used by Solana Overview/Risk Engine, never a new scorer.
    // DIRECTION FIX, DISCLOSED (Solana risk-score-direction task): this snapshot always claimed
    // `riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier'`, but `risk.score` is a
    // SAFETY-style read (higher = safer) — the claim was false. `snapshotFromScan` gates
    // `canTrackOutcome` directly on this value (lib/server/tokenOutcomeReceipt.ts), so a genuinely
    // dangerous, low-`risk.score` token was incorrectly rejected as ineligible while a safe,
    // high-`risk.score` token was incorrectly accepted — the exact inversion this task fixes. Now
    // reads `risk.riskScore`/`risk.riskLabel`, the canonical (higher = riskier) fields added in
    // lib/solanaCortexRisk.ts, making the claim true. `risk.factors`/`risk.securityRead`/
    // `risk.modules` below are unchanged, real evidence — never altered by this fix.
    const risk = computeSolanaCortexRisk(scan)
    const snapshot = snapshotFromScan({
      chain: 'solana', contract: scan.mintAddress, symbol: scan.resolvedTokenSymbol, name: scan.resolvedTokenName,
      scanRequestId: scanId, scanRequestStartedAt: startedAt, riskScore: risk.riskScore,
      riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier', riskLabel: risk.riskLabel,
      riskBreakdown: risk.factors, security: risk.securityRead,
      lpControl: scan.poolProgram, holderDistribution: scan.topAccountConcentration,
      devIntel: scan.deepCreator, contractFlags: { mintAuthority: scan.mintAuthority, freezeAuthority: scan.freezeAuthority, authorityReadSucceeded: scan.authorityReadSucceeded },
      priceUsd: scan.marketData?.priceUsd, liquidityUsd: scan.marketData?.liquidityUsd,
      marketCapUsd: scan.marketData?.marketCapUsd, riskInputsUsed: risk.modules,
    }, userId)
    return snapshot ? signOutcomeSnapshot(snapshot) : null
  } catch { return null }
}
