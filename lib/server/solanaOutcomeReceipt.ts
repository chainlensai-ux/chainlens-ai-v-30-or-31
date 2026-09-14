import type { SolanaBetaScanResult } from './solanaTokenScannerBeta'
import { computeSolanaCortexRisk } from '../solanaCortexRisk'
import { signOutcomeSnapshot, snapshotFromScan } from './tokenOutcomeReceipt'

export function solanaOutcomeReceipt(scan: SolanaBetaScanResult, userId: string, scanId: string, startedAt: number): string | null {
  try {
    // Same canonical read already used by Solana Overview/Risk Engine, never a new scorer.
    const risk = computeSolanaCortexRisk(scan)
    const snapshot = snapshotFromScan({
      chain: 'solana', contract: scan.mintAddress, symbol: scan.resolvedTokenSymbol, name: scan.resolvedTokenName,
      scanRequestId: scanId, scanRequestStartedAt: startedAt, riskScore: risk.score,
      riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier', riskLabel: risk.verdict,
      riskBreakdown: risk.factors, security: risk.securityRead,
      lpControl: scan.poolProgram, holderDistribution: scan.topAccountConcentration,
      devIntel: scan.deepCreator, contractFlags: { mintAuthority: scan.mintAuthority, freezeAuthority: scan.freezeAuthority, authorityReadSucceeded: scan.authorityReadSucceeded },
      priceUsd: scan.marketData?.priceUsd, liquidityUsd: scan.marketData?.liquidityUsd,
      marketCapUsd: scan.marketData?.marketCapUsd, riskInputsUsed: risk.modules,
    }, userId)
    return snapshot ? signOutcomeSnapshot(snapshot) : null
  } catch { return null }
}
