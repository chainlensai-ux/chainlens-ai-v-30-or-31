// MODULE 8 — finalReportAssembler: pure helper functions that synthesize `finalSummary`.
//
// Every function here only rephrases/compresses a fact that already exists in an upstream
// section — none of them introduce a new independent judgment (Architecture Step 6 §8, Step 9
// §8: "no section may claim higher confidence than the data supports").

import type { ChainSelectionResult } from '../chainSelection/types'
import type { FifoOutput, PublicPnlStatus } from '../fifoEngine/types'
import type { RecoveryPolicyResult } from '../recoveryPolicy/types'
import type { BehaviorIntelResult } from '../behaviorIntel/types'

const PNL_STATUS_HEADLINES: Record<PublicPnlStatus, string> = {
  unavailable: 'PnL unavailable due to missing evidence.',
  limited_verified_sample: 'Profit skill locked — sample too small to publish an official win rate.',
  ok: 'Verified FIFO sample — official PnL available.',
}

export function buildFinancialStatusHeadline(fifoAndPnl: FifoOutput): string {
  return PNL_STATUS_HEADLINES[fifoAndPnl.publicPnlStatus]
}

export function buildWalletPersonality(behaviorIntel: BehaviorIntelResult): string {
  const { rotationStyle, riskOnOff, concentrationSignals } = behaviorIntel
  if (rotationStyle.value === 'unknown' && riskOnOff.value === 'unknown') {
    return 'Insufficient data to classify wallet behavior.'
  }
  const styleLabel = rotationStyle.value === 'unknown' ? 'wallet with unclear trading pattern' : `${rotationStyle.value} wallet`
  const concentrationClause = concentrationSignals?.concentrationLabel === 'high'
    ? `, with high concentration in ${concentrationSignals.topHoldingSymbol}`
    : ''
  const chainClause = behaviorIntel.multiChainParticipation.activeChains.length > 1 ? 'Multi-chain ' : ''
  return `${chainClause}${styleLabel}${concentrationClause}.`
}

export function buildChainParticipationSummary(chainSelection: ChainSelectionResult): string {
  const active = chainSelection.chains.filter((c) => c.status === 'active_intelligence').map((c) => c.chain)
  const dust = chainSelection.chains.filter((c) => c.status === 'dust_low_signal').map((c) => c.chain)
  if (active.length === 0) return 'No chains met the activity/value/swap gates for deep intelligence.'
  const activeClause = `Active on ${active.join(', ')}`
  const dustClause = dust.length > 0 ? `; ${dust.join(', ')} ${dust.length === 1 ? 'is' : 'are'} dust and excluded from deep intelligence.` : '.'
  return `${activeClause}${dustClause}`
}

export function buildRecoverySummary(recoveryPolicy: RecoveryPolicyResult): string {
  const triggered = recoveryPolicy.evaluation.filter((e) => e.recoveryTriggered)
  if (triggered.length === 0) return 'No recovery attempted.'
  const succeeded = triggered.filter((e) => e.pagesUsed > 0).length
  return `${recoveryPolicy.totalPagesUsedThisWallet} page(s) used; cost-basis recovery succeeded for ${succeeded} of ${triggered.length} triggered token(s).`
}
