import { ROBINHOOD_CHAIN_ID } from './robinhoodChainConfig'

export type RobinhoodBlockscoutFallbackFeature = 'lp_safety' | 'wallet_scanner'
export type RobinhoodBlockscoutFallbackFinalStatus =
  | 'skipped_primary_succeeded'
  | 'fallback_succeeded'
  | 'fallback_returned_no_rows'
  | 'fallback_unavailable'
  | 'not_configured'
  | 'not_applicable'

export type BlockscoutFallbackDecisionAudit = {
  chainId: 4663
  feature: RobinhoodBlockscoutFallbackFeature
  primaryAttempted: boolean
  primarySucceeded: boolean
  primaryRowsReturned: number
  primaryMissingFields: string[]
  shouldUseBlockscout: boolean
  blockscoutConfigured: boolean
  blockscoutAttempted: boolean
  blockscoutEndpointsTried: string[]
  blockscoutRowsReturned: number
  blockscoutSuccess: boolean
  blockscoutFailureReason: string | null
  finalStatus: RobinhoodBlockscoutFallbackFinalStatus
}

export function logBlockscoutFallbackDecisionAudit(audit: BlockscoutFallbackDecisionAudit): BlockscoutFallbackDecisionAudit {
  // Safe diagnostic: endpoint paths and counts only; no API key or response payload is logged.
  console.log('[blockscoutFallbackDecisionAudit]', audit)
  return audit
}

export function createBlockscoutFallbackDecisionAudit(
  input: Omit<BlockscoutFallbackDecisionAudit, 'chainId'>,
): BlockscoutFallbackDecisionAudit {
  return { chainId: ROBINHOOD_CHAIN_ID, ...input }
}
