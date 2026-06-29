export type WalletProviderName = 'zerion' | 'goldrush' | 'alchemy' | 'moralis'
export type WalletProviderPurpose = 'holdings' | 'portfolio' | 'activity' | 'pricing' | 'receipt_proof' | 'historical_recovery' | 'provider_pnl_summary'
export type WalletProviderScanMode = 'normal' | 'deep' | 'full_recovery'

export type WalletProviderCallRequest = {
  provider: WalletProviderName
  endpointName: string
  purpose: WalletProviderPurpose
  estimatedCredits: number
  scanMode: WalletProviderScanMode
  allowedByMode: boolean
  cacheKey: string
  timeoutMs: number
}

export type WalletProviderBudgetInput = WalletProviderCallRequest & {
  currentCreditsUsed: number
  targetCredits: number
  hardCapCredits: number
  isAdminFullRecovery: boolean
}

export type WalletProviderBudgetDecision = {
  allowed: boolean
  blockedReason: string | null
  blockedBucket: 'mode' | 'budget' | 'admin' | null
}

export type WalletProviderCallAuditEntry = {
  provider: WalletProviderName
  endpointName: string
  purpose: WalletProviderPurpose
  attempted: boolean
  allowed: boolean
  blockedReason: string | null
  cacheHit: boolean
  creditsEstimated: number
  durationMs: number
}

export type WalletProviderCallAudit = {
  calls: WalletProviderCallAuditEntry[]
  totals: {
    zerionCredits: number
    goldrushCredits: number
    moralisCalls: number
    moralisCuEstimate: number
    alchemyCalls: number
    alchemyLoadUnits: number
    totalProviderCredits: number
  }
  blockedByMode: string[]
  blockedByBudget: string[]
  blockedByAdmin: string[]
}
