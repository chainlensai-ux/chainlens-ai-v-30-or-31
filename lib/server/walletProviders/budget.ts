import type { WalletProviderBudgetDecision, WalletProviderBudgetInput, WalletProviderCallAudit, WalletProviderCallAuditEntry } from './types'

export function canUseWalletProviderCall(input: WalletProviderBudgetInput): WalletProviderBudgetDecision {
  if (input.scanMode === 'full_recovery' && !input.isAdminFullRecovery) {
    return { allowed: false, blockedReason: 'full_recovery_requires_admin', blockedBucket: 'admin' }
  }
  if (!input.allowedByMode) {
    return { allowed: false, blockedReason: `${input.scanMode}_blocks_${input.provider}_${input.purpose}`, blockedBucket: 'mode' }
  }
  if (input.provider === 'moralis' && (input.purpose === 'activity' || input.purpose === 'historical_recovery' || input.purpose === 'provider_pnl_summary') && !input.isAdminFullRecovery) {
    return { allowed: false, blockedReason: 'moralis_recovery_requires_admin_full_recovery', blockedBucket: input.scanMode === 'full_recovery' ? 'admin' : 'mode' }
  }
  if (input.currentCreditsUsed + input.estimatedCredits > input.hardCapCredits) {
    return { allowed: false, blockedReason: 'wallet_provider_hard_cap_reached', blockedBucket: 'budget' }
  }
  return { allowed: true, blockedReason: null, blockedBucket: null }
}

export function createWalletProviderCallAudit(): WalletProviderCallAudit {
  return { calls: [], totals: { zerionCredits: 0, goldrushCredits: 0, moralisCalls: 0, moralisCuEstimate: 0, alchemyCalls: 0, alchemyLoadUnits: 0, totalProviderCredits: 0 }, blockedByMode: [], blockedByBudget: [], blockedByAdmin: [] }
}

export function recordWalletProviderCall(audit: WalletProviderCallAudit, entry: WalletProviderCallAuditEntry): void {
  audit.calls.push(entry)
  if (entry.allowed && !entry.cacheHit) {
    if (entry.provider === 'zerion') audit.totals.zerionCredits += entry.creditsEstimated
    if (entry.provider === 'goldrush') audit.totals.goldrushCredits += entry.creditsEstimated
    if (entry.provider === 'moralis') { audit.totals.moralisCalls += 1; audit.totals.moralisCuEstimate += entry.creditsEstimated }
    if (entry.provider === 'alchemy') { audit.totals.alchemyCalls += 1; audit.totals.alchemyLoadUnits += Math.max(1, entry.creditsEstimated) }
    audit.totals.totalProviderCredits += entry.provider === 'alchemy' ? 0 : entry.creditsEstimated
  }
  if (!entry.allowed && entry.blockedReason) {
    const id = `${entry.provider}:${entry.endpointName}:${entry.blockedReason}`
    if (entry.blockedReason.includes('admin')) audit.blockedByAdmin.push(id)
    else if (entry.blockedReason.includes('cap') || entry.blockedReason.includes('budget')) audit.blockedByBudget.push(id)
    else audit.blockedByMode.push(id)
  }
}
