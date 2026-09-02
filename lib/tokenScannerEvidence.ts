// TOKEN SCANNER SHARED EVIDENCE STATE — DISCLOSED.
// One classifier for Holder / Dev / Risk / CORTEX / Sidebar / Wallet Detail.
// Never fakes deployer, dev supply, linked wallets, or LP proof.
// Missing holder rows are not treated as 0%. Graph "0 mapped" is only valid after the graph ran.

import type { LinkedWalletGraphStatus } from './devClusterDiagnosis'

export const ROBINHOOD_EVIDENCE_CHAIN_ID = 4663

export const DEV_SUPPLY_DEPLOYER_UNRESOLVED = 'Dev supply not checked — deployer not resolved'
export const NOT_IN_INDEXED_HOLDER_ROWS = 'Not in indexed holder rows'
export const GRAPH_RAN_NONE_LABEL = '0 confirmed'
export const GRAPH_NOT_RUN_PREFIX = 'Linked wallet graph not run'
export const CAUTION_ELEVATED_COPY = 'Elevated risk — missing LP/dev verification'
export const CAUTION_HOLDERS_VERIFIED_COPY =
  'Holder concentration and market data verified. LP proof incomplete; dev origin unresolved.'

export type TokenScannerEvidenceStatus =
  | 'verified'
  | 'partial'
  | 'not_checked'
  | 'unavailable'
  | 'not_in_indexed_holder_rows'
  | 'unknown'

export interface TokenScannerEvidenceHolderRow {
  address?: string | null
  percent?: number | null
  rank?: number | null
}

export interface TokenScannerEvidenceInput {
  holdersVerified: boolean
  holderRows?: TokenScannerEvidenceHolderRow[] | null
  deployerAddress?: string | null
  selectedWallet?: string | null
  graphStatus?: LinkedWalletGraphStatus | null
  graphFailureReason?: string | null
  walletsMapped?: number | null
  lpProofComplete?: boolean | null
  lpProofStatus?: string | null
  chainId?: number | null
  chainSlug?: string | null
  marketVerified?: boolean | null
}

export interface TokenScannerEvidenceLabels {
  supplyControl: string
  creatorInTop: string
  linkedWallets: string
  linkedWalletsEmptyTitle: string
  linkedWalletsEmptyBody: string
  walletSupply: string
  walletHolderRank: string
  currentHolder: string
  receivedSupplyAtLaunch: string
  transferredOrSold: string
  clusterSupply: string
  riskCopy: string | null
  confidence: string
}

export interface TokenScannerEvidence {
  holdersVerified: boolean
  deployerResolved: boolean
  walletInIndexedRows: boolean | null
  lpProofComplete: boolean
  graphStatus: LinkedWalletGraphStatus | 'unknown'
  graphRan: boolean
  chainId: number | null
  robinhoodIsolated: boolean
  holdersStatus: TokenScannerEvidenceStatus
  deployerStatus: TokenScannerEvidenceStatus
  graphEvidenceStatus: TokenScannerEvidenceStatus
  lpStatus: TokenScannerEvidenceStatus
  walletStatus: TokenScannerEvidenceStatus
  labels: TokenScannerEvidenceLabels
}

const ZERO = '0x0000000000000000000000000000000000000000'

export function tokenScannerEvidenceChainId(
  chainSlug?: string | null,
  chainId?: number | null,
): number | null {
  if (chainId === ROBINHOOD_EVIDENCE_CHAIN_ID || chainSlug === 'robinhood') return ROBINHOOD_EVIDENCE_CHAIN_ID
  if (typeof chainId === 'number' && Number.isFinite(chainId)) return chainId
  if (chainSlug === 'eth') return 1
  if (chainSlug === 'base') return 8453
  if (chainSlug === 'bnb') return 56
  if (chainSlug === 'polygon') return 137
  return null
}

export function isRobinhoodEvidenceChain(chainId: number | null | undefined, chainSlug?: string | null): boolean {
  return tokenScannerEvidenceChainId(chainSlug, chainId) === ROBINHOOD_EVIDENCE_CHAIN_ID
}

export function normalizeEvidenceAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const n = value.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(n) || n === ZERO) return null
  return n
}

export function walletInIndexedHolderRows(
  holderRows: TokenScannerEvidenceHolderRow[] | null | undefined,
  wallet: string | null | undefined,
): boolean | null {
  const addr = normalizeEvidenceAddress(wallet)
  if (!addr) return null
  if (!holderRows || holderRows.length === 0) return null
  return holderRows.some((row) => normalizeEvidenceAddress(row.address) === addr)
}

export function graphFailureReason(reason?: string | null): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  return trimmed || 'transfer graph did not run'
}

export function linkedWalletGraphLabel(
  graphStatus: LinkedWalletGraphStatus | null | undefined,
  failureReason?: string | null,
  walletsMapped?: number | null,
): string {
  if (graphStatus === 'ran_found' && (walletsMapped ?? 0) > 0) {
    const n = walletsMapped ?? 0
    return `${n} mapped`
  }
  if (graphStatus === 'ran_none') return GRAPH_RAN_NONE_LABEL
  if (graphStatus === 'not_run' || graphStatus === 'unavailable') {
    return `${GRAPH_NOT_RUN_PREFIX}: ${graphFailureReason(failureReason)}`
  }
  return `${GRAPH_NOT_RUN_PREFIX}: ${graphFailureReason(failureReason ?? 'transfer graph did not run')}`
}

export function cautionRiskCopy(evidence?: { holdersVerified?: boolean } | null): string {
  return evidence?.holdersVerified ? CAUTION_HOLDERS_VERIFIED_COPY : CAUTION_ELEVATED_COPY
}

export function lpProofIsComplete(input: {
  lpProofComplete?: boolean | null
  lpProofStatus?: string | null
}): boolean {
  if (input.lpProofComplete === true) return true
  const status = (input.lpProofStatus ?? '').toLowerCase()
  return status === 'verified' || status === 'locked' || status === 'burned'
}

function lpStatusOf(complete: boolean, rawStatus?: string | null): TokenScannerEvidenceStatus {
  if (complete) return 'verified'
  const status = (rawStatus ?? '').toLowerCase()
  if (status === 'not_applicable' || status === 'protocol' || status === 'concentrated_liquidity') return 'unavailable'
  if (status === 'partial') return 'partial'
  if (!status || status === 'not_checked' || status === 'not_attempted') return 'not_checked'
  return 'unavailable'
}

function yesNoOrState(value: 'yes' | 'no' | 'unknown' | null | undefined, unknownLabel: string): string {
  if (value === 'yes') return 'Yes'
  if (value === 'no') return 'No'
  return unknownLabel
}

export function classifyTokenScannerEvidence(input: TokenScannerEvidenceInput): TokenScannerEvidence {
  const chainId = tokenScannerEvidenceChainId(input.chainSlug, input.chainId)
  const robinhoodIsolated = chainId === ROBINHOOD_EVIDENCE_CHAIN_ID
  const holderRows = input.holderRows ?? []
  const holdersVerified = input.holdersVerified === true
  const deployerAddress = normalizeEvidenceAddress(input.deployerAddress)
  const selectedWallet = normalizeEvidenceAddress(input.selectedWallet) ?? deployerAddress
  const deployerResolved = deployerAddress != null
  const inRows = walletInIndexedHolderRows(holderRows, selectedWallet)
  const graphStatus = input.graphStatus ?? 'not_run'
  const graphRan = graphStatus === 'ran_found' || graphStatus === 'ran_none'
  const lpComplete = lpProofIsComplete(input)
  const linkedLabel = linkedWalletGraphLabel(graphStatus, input.graphFailureReason, input.walletsMapped)
  const graphNotRun = graphStatus === 'not_run' || graphStatus === 'unavailable'

  const walletAbsent = holdersVerified && selectedWallet != null && inRows === false
  const deployerUnresolvedWithHolders = holdersVerified && !deployerResolved

  const supplyControl = deployerUnresolvedWithHolders
    ? DEV_SUPPLY_DEPLOYER_UNRESOLVED
    : holdersVerified
      ? (inRows === false && selectedWallet ? NOT_IN_INDEXED_HOLDER_ROWS : 'Holder concentration verified')
      : 'Needs holder evidence'

  const creatorInTop = deployerUnresolvedWithHolders
    ? DEV_SUPPLY_DEPLOYER_UNRESOLVED
    : inRows === true
      ? 'Yes'
      : inRows === false && holdersVerified
        ? 'No'
        : holdersVerified
          ? DEV_SUPPLY_DEPLOYER_UNRESOLVED
          : 'Needs holder evidence'

  const walletSupply = walletAbsent
    ? NOT_IN_INDEXED_HOLDER_ROWS
    : deployerUnresolvedWithHolders
      ? DEV_SUPPLY_DEPLOYER_UNRESOLVED
      : holdersVerified && inRows === true
        ? 'Verified'
        : holdersVerified
          ? NOT_IN_INDEXED_HOLDER_ROWS
          : 'Holder data unavailable'

  const unknownReplacement = walletAbsent
    ? NOT_IN_INDEXED_HOLDER_ROWS
    : deployerUnresolvedWithHolders
      ? DEV_SUPPLY_DEPLOYER_UNRESOLVED
      : inRows === true
        ? 'Not checked'
        : holdersVerified
          ? NOT_IN_INDEXED_HOLDER_ROWS
          : 'Not checked'

  const labels: TokenScannerEvidenceLabels = {
    supplyControl,
    creatorInTop,
    linkedWallets: linkedLabel,
    linkedWalletsEmptyTitle: graphNotRun
      ? linkedLabel
      : graphStatus === 'ran_none'
        ? '0 confirmed linked wallets'
        : 'Cluster wallets not verified',
    linkedWalletsEmptyBody: graphNotRun
      ? linkedLabel
      : graphStatus === 'ran_none'
        ? 'Graph ran and found no qualifying linked wallets.'
        : linkedLabel,
    walletSupply,
    walletHolderRank: walletSupply,
    currentHolder: unknownReplacement,
    receivedSupplyAtLaunch: unknownReplacement,
    transferredOrSold: graphNotRun ? linkedLabel : unknownReplacement,
    clusterSupply: deployerUnresolvedWithHolders
      ? DEV_SUPPLY_DEPLOYER_UNRESOLVED
      : holdersVerified
        ? (graphNotRun ? linkedLabel : 'Holder concentration verified')
        : 'Needs holder evidence',
    riskCopy: cautionRiskCopy({ holdersVerified }),
    confidence: walletAbsent
      ? NOT_IN_INDEXED_HOLDER_ROWS
      : deployerUnresolvedWithHolders
        ? DEV_SUPPLY_DEPLOYER_UNRESOLVED
        : holdersVerified
          ? 'medium'
          : 'Not checked',
  }

  return {
    holdersVerified,
    deployerResolved,
    walletInIndexedRows: selectedWallet ? (inRows ?? false) : null,
    lpProofComplete: lpComplete,
    graphStatus,
    graphRan,
    chainId,
    robinhoodIsolated,
    holdersStatus: holdersVerified ? 'verified' : holderRows.length > 0 ? 'partial' : 'unavailable',
    deployerStatus: deployerResolved ? 'verified' : holdersVerified ? 'not_checked' : 'unknown',
    graphEvidenceStatus: graphStatus === 'ran_found'
      ? 'verified'
      : graphStatus === 'ran_none'
        ? 'verified'
        : graphNotRun
          ? 'not_checked'
          : 'unavailable',
    lpStatus: lpStatusOf(lpComplete, input.lpProofStatus),
    walletStatus: walletAbsent
      ? 'not_in_indexed_holder_rows'
      : inRows === true
        ? 'verified'
        : deployerUnresolvedWithHolders
          ? 'not_checked'
          : holdersVerified
            ? 'not_in_indexed_holder_rows'
            : 'unknown',
    labels,
  }
}

export function displayYesNoUnknown(
  value: 'yes' | 'no' | 'unknown' | null | undefined,
  evidence: TokenScannerEvidence,
  fallback?: string,
): string {
  return yesNoOrState(value, fallback ?? evidence.labels.currentHolder)
}

export function evidenceLabelsAreSpecific(label: string): boolean {
  const raw = label.trim()
  if (!raw) return false
  if (/^unknown$/i.test(raw)) return false
  if (/^open check$/i.test(raw)) return false
  if (/^pending$/i.test(raw)) return false
  return true
}
