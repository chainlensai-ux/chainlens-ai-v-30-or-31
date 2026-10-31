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
  /** Current balance vs boughtRaw; present only alongside a current-holdings read. */
  balanceComparison?: BalanceComparison
}
export type BuyerGroup = {
  tier: Tier
  wallets: string[]
  transactions: string[]
  reason: string
  boughtWithinEarlySetPct: number | null
  heldWithinEarlySetPct: number | null
  /** Group delivered amount / delivered amount of recipients that are not shared recipients (see DeliveryGraph). */
  boughtWithinOrdinaryRecipientsPct?: number | null
  associationType?: 'shared_transaction_delivery' | 'common_initiator' | 'shared_contract_call'
}

/**
 * A recipient that co-received in 3+ multi-recipient transactions whose other recipients form 3+
 * disconnected partner clusters. It never links other wallets into T1. The fee/distribution label
 * additionally needs a near-constant minority share across 3+ distinct signers; neither label proves
 * ownership, purpose, or payment.
 */
export type SharedRecipient = {
  wallet: string
  classification: 'high_frequency_shared_recipient' | 'fee_or_distribution_pattern'
  transactions: string[]
  partnerClusters: number
  /** Distinct transaction signers across its transactions; null when signers were not stored. */
  signers: number | null
  /** Its share of each transaction's pool-sourced deliveries, in basis points; null without per-transaction amounts. */
  shareBps: { min: number; max: number } | null
  reason: string
}

export type DeliveryGraph = {
  /** 'transaction_facts' = built from receipts; 'legacy_rebuild' = rebuilt from a stored row without per-transaction amounts or signers. */
  source: 'transaction_facts' | 'legacy_rebuild'
  /** Transactions that delivered pool-sourced tokens to 2+ recipients (ERC-4337 bundles excluded). */
  multiRecipientTransactions: number
  /** Of those, transactions that still link 2+ ordinary recipients once shared recipients are set aside. */
  linkingTransactions: number
  sharedRecipients: SharedRecipient[]
  /** Ordinary recipients in no T1 group. */
  unlinkedRecipients: number
  denominators: {
    observedRecipients: number
    observedDeliveredRaw: string
    ordinaryRecipients: number
    ordinaryDeliveredRaw: string
  }
}

/** Current balances, read in one Multicall3 call so every value comes from the same block. */
export type CurrentHoldingsSnapshot = {
  blockNumber: number | null
  blockTimestampSec: number | null
  /** Server clock when the read returned (ms). */
  readAtMs: number
  source: 'live' | 'cache'
  /** Seconds since readAtMs when served from the holdings cache; 0 for a live read. */
  cacheAgeSec: number
  walletsRead: number
  walletsObserved: number
}

export type SupplyExposure = {
  status: 'available' | 'unavailable'
  reason: string | null
  blockNumber: number | null
  totalSupplyRaw: string | null
  /** Sum of current balances of every observed recipient (unique wallets). */
  observedHeldRaw: string | null
  /** observedHeldRaw / totalSupplyRaw. */
  observedPct: number | null
  /** Same, without shared recipients. Total supply is never reduced. */
  ordinaryHeldRaw: string | null
  ordinaryPct: number | null
  walletsIncluded: number
  excludedSharedRecipients: string[]
}
export const EARLY_BUYER_WINDOW_SCOPE = 'bounded_first_trade_window' as const
export type EarlyBuyerWindowScope = typeof EARLY_BUYER_WINDOW_SCOPE
export type HoldingsRefreshStatus = 'available' | 'unavailable' | 'failed' | 'partial'

export type EarlyBuyerIntel = {
  status: IntelStatus
  launch: { status: 'verified' | 'estimated' | 'unsupported_launch_venue' | 'unavailable'; block: number | null; pool: string | null; creationTx: string | null; liquidityTx: string | null }
  /** startBlock/endBlock are the nominal window whose swap logs were requested. `examined` is the receipt coverage actually inspected. */
  window: { startBlock: number | null; endBlock: number | null; pools: string[]; buysObserved: number; examined?: WindowExamined }
  buyers: EarlyBuyer[]
  groups: BuyerGroup[]
  deliveryGraph?: DeliveryGraph
  currentHoldings?: CurrentHoldingsSnapshot
  supplyExposure?: SupplyExposure
  sameBlockCount: number
  launchDistributions: Array<{ wallet: string; rawAmount: string; txHash: string }>
  coverage: { capped: boolean; reasons: string[]; provisional: boolean; scope: EarlyBuyerWindowScope }
  /** Launch investigation before the current-balance overlay. Absent on older rows; readers fall back to status. */
  evidenceStatus?: IntelStatus
  /** Current wallet balances. Missing means no refresh evidence, not a zero balance. */
  holdingsStatus?: HoldingsRefreshStatus
  budget: { calls: number; cu: number; externalRequests?: number; actualProviderCu?: number | null; blockReceiptCalls?: number; blockReceiptThroughputCu?: number }
  discovery?: {
    earliestDiscoveredPool: string | null
    earliestVerifiedPool: string | null
    candidates: Array<{ pool: string; createdAt: number | null; outcome: 'verified' | 'estimated' | 'skipped' | 'unresolved' | 'excluded'; reason: string }>
    complete: boolean
  }
}

export type WindowExamined = {
  /** First and last block of a receipt that was inspected; null when none was. */
  startBlock: number | null
  endBlock: number | null
  /** Swap-transaction receipts inspected. */
  receipts: number
  /** Distinct swap transactions found in the nominal window's swap logs. */
  swapTransactions: number
  /** Receipts that produced at least one pool-sourced delivery. */
  attributedTransactions?: number
  /** Receipts rejected because the swap could not be separated from other activity. */
  rejectedTransactions?: number
  /** Receipts read, but no pool-sourced recipient could be proven. */
  unresolvedTransactions?: number
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

export type BalanceComparison = {
  relation: 'unavailable' | 'no_observed_receipt' | 'zero_balance' | 'below_observed_receipts' | 'equal_to_observed_receipts' | 'exceeds_observed_receipts'
  /** current balance / observed launch-window receipts, in percent (2 dp). Null when not meaningful. */
  ratioPct: number | null
}

/**
 * Current balance against tokens observed received in the launch window. Describes the two numbers
 * only: a lower or zero balance is not a sale, and a higher one is not a purchase.
 */
export function compareBalanceToObservedReceipts(boughtRaw: string, heldRaw: string | null | undefined): BalanceComparison {
  if (heldRaw == null || !/^\d+$/.test(heldRaw) || !/^\d+$/.test(boughtRaw)) return { relation: 'unavailable', ratioPct: null }
  const bought = BigInt(boughtRaw), held = BigInt(heldRaw)
  if (bought === BigInt(0)) return { relation: 'no_observed_receipt', ratioPct: null }
  const ratioPct = Number(held * BigInt(10000) / bought) / 100
  if (held === BigInt(0)) return { relation: 'zero_balance', ratioPct: 0 }
  return { relation: held > bought ? 'exceeds_observed_receipts' : held === bought ? 'equal_to_observed_receipts' : 'below_observed_receipts', ratioPct }
}

/** Percentage of `part` in `whole` with `dp` decimals, computed in integers. Null when whole is zero. */
export function rawPct(part: bigint, whole: bigint, dp = 2): number | null {
  if (whole <= BigInt(0)) return null
  const scale = BigInt(10) ** BigInt(dp)
  return Number(part * BigInt(100) * scale / whole) / Number(scale)
}
