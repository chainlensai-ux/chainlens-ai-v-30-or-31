export type ClarkWhaleFlowRow = {
  id: string
  token: string
  tokenAddress: string | null
  chain: string
  walletLabel: string
  walletAddress: string | null
  txCount: number
  usdValue: number | null
  usdStatus: 'verified' | 'estimated' | 'zero' | 'unavailable'
  usdReason: string | null
  confidence: string
  lastSeen: string | null
}

export type ClarkWhaleWalletRow = {
  id: string
  label: string
  address: string
  chain: string
  lastActive: string | null
  buys: number
  sells: number
  portfolioUsd: number | null
  confidence: string
}

export type ClarkWhaleIntelligenceUi = {
  kind: 'flow' | 'wallets'
  side?: 'buy' | 'sell'
  summary: string
  lastSyncedAt: string | null
  stale: boolean
  incomplete: boolean
  syncRecommended: boolean
  flowRows?: ClarkWhaleFlowRow[]
  walletRows?: ClarkWhaleWalletRow[]
}

export function parseClarkWhaleIntelligenceUi(value: unknown): ClarkWhaleIntelligenceUi | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Partial<ClarkWhaleIntelligenceUi>
  if ((row.kind !== 'flow' && row.kind !== 'wallets') || typeof row.summary !== 'string') return undefined
  return row as ClarkWhaleIntelligenceUi
}

export function buildClarkWhaleIntelligenceUi(
  value: Omit<ClarkWhaleIntelligenceUi, 'stale' | 'incomplete' | 'syncRecommended'>,
  now = Date.now(),
): ClarkWhaleIntelligenceUi {
  const syncedAt = value.lastSyncedAt ? new Date(value.lastSyncedAt).getTime() : NaN
  const stale = !Number.isFinite(syncedAt) || now - syncedAt > 15 * 60 * 1000
  const flowRows = value.flowRows ?? []
  const unavailableCount = flowRows.filter(row => row.usdStatus === 'unavailable').length
  const incomplete = flowRows.length > 0 && unavailableCount / flowRows.length >= 0.35
  return { ...value, stale, incomplete, syncRecommended: stale || incomplete }
}
