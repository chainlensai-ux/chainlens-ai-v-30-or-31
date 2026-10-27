export type EarlyBuyerChain = 'base' | 'eth'
export type IntelStatus = 'verified' | 'estimated' | 'partial' | 'unsupported_launch_venue' | 'unavailable' | 'unsupported_chain'
export type Tier = 'T1' | 'T2'
export type AcquisitionProof = {
  txHash: string
  pool: string
  block: number
  timestampSec: number | null
  reason: 'pool_sourced_token_delivery_in_swap_transaction'
}

export type EarlyBuyer = {
  wallet: string
  purchaseProven?: false
  boughtRaw: string
  heldRaw: string | null
  transactions: string[]
  blocks: number[]
  evidence?: AcquisitionProof[]
}
export type BuyerGroup = {
  tier: Tier
  wallets: string[]
  transactions: string[]
  reason: string
  boughtWithinEarlySetPct: number | null
  heldWithinEarlySetPct: number | null
  associationType?: 'shared_transaction_delivery' | 'common_initiator' | 'shared_contract_call'
}
export const EARLY_BUYER_WINDOW_SCOPE = 'bounded_first_trade_window' as const
export type EarlyBuyerWindowScope = typeof EARLY_BUYER_WINDOW_SCOPE
export type HoldingsRefreshStatus = 'available' | 'unavailable' | 'failed' | 'partial'

export type EarlyBuyerIntel = {
  status: IntelStatus
  launch: { status: 'verified' | 'estimated' | 'unsupported_launch_venue' | 'unavailable'; block: number | null; pool: string | null; creationTx: string | null; liquidityTx: string | null }
  window: { startBlock: number | null; endBlock: number | null; pools: string[]; buysObserved: number }
  buyers: EarlyBuyer[]
  groups: BuyerGroup[]
  sameBlockCount: number
  launchDistributions: Array<{ wallet: string; rawAmount: string; txHash: string }>
  coverage: { capped: boolean; reasons: string[]; provisional: boolean; scope: EarlyBuyerWindowScope }
  /** Launch investigation before the current-balance overlay. Absent on older rows; readers fall back to status. */
  evidenceStatus?: IntelStatus
  /** Current wallet balances. Missing means no refresh evidence, not a zero balance. */
  holdingsStatus?: HoldingsRefreshStatus
  budget: { calls: number; cu: number; externalRequests?: number; actualProviderCu?: number | null }
  discovery?: {
    earliestDiscoveredPool: string | null
    earliestVerifiedPool: string | null
    candidates: Array<{ pool: string; createdAt: number | null; outcome: 'verified' | 'estimated' | 'skipped' | 'unresolved' | 'excluded'; reason: string }>
    complete: boolean
  }
}

export type Transfer = { from: string; to: string; rawAmount: bigint; txHash: string; block: number; logIndex?: number }
export type BuyFact = { wallet: string; rawAmount: bigint; txHash: string; block: number; signer: string; called: string | null; transactionIndex: number; pool?: string; timestampSec?: number | null }

export function earlyBuyerDisplayStatus(intel: EarlyBuyerIntel): { launch: 'VERIFIED' | 'PARTIAL' | 'UNAVAILABLE'; holdings: 'AVAILABLE' | 'UNAVAILABLE' | 'FAILED' | 'PARTIAL' } {
  const evidence = intel.evidenceStatus ?? intel.status
  const launch = evidence === 'verified' ? 'VERIFIED' : evidence === 'partial' || evidence === 'estimated' ? 'PARTIAL' : 'UNAVAILABLE'
  const holdings = intel.holdingsStatus === 'available' ? 'AVAILABLE' : intel.holdingsStatus === 'failed' ? 'FAILED' : intel.holdingsStatus === 'partial' ? 'PARTIAL' : 'UNAVAILABLE'
  return { launch, holdings }
}

/** A missing balance stays unavailable. The string "0" is a measured zero and is preserved. */
export function heldRawLabel(heldRaw: string | null | undefined): string {
  return heldRaw == null || heldRaw === '' ? 'UNAVAILABLE' : `${heldRaw} raw`
}
