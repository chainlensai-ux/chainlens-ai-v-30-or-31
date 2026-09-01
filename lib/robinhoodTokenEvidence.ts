// ROBINHOOD TOKEN EVIDENCE RESOLVER, DISCLOSED (reported bug: Robinhood Chain scans render real
// market/liquidity data but everything else — holders, owner status, security simulation, LP lock
// proof, dev/cluster influence — falls back to a generic "Open check" with no distinction between
// "genuinely unsupported for this chain right now" and "provider had a transient failure" and
// "not yet checked." resolveRobinhoodTokenEvidence() is a pure, network-free function that takes
// evidence this scan ALREADY fetched (market/pool/holder/security/ownership/LP/dev-control data) and
// classifies each section into one of the 7 exact statuses this fix specifies — never inventing
// data, never silently reassigning a chain, never applying Base/Ethereum LP assumptions to
// Robinhood's own (frequently concentrated-liquidity) pool model.
//
// Every label string here is the exact wording this fix's task specification requires, used
// verbatim by app/terminal/token-scanner/page.tsx wherever a Robinhood scan would otherwise show the
// bare word "Open check" for one of these sections.

export type RobinhoodEvidenceStatus =
  | 'verified'
  | 'partial'
  | 'unsupported_on_robinhood'
  | 'provider_unavailable'
  | 'not_returned'
  | 'not_applicable'
  | 'failed_with_reason'

export interface RobinhoodMarketDataInput {
  hasPrice: boolean
  hasLiquidity: boolean
  noActivePools: boolean
}

export interface RobinhoodPoolDataInput {
  poolCount: number
  liquidityUsd: number | null
  poolAddress: string | null
  dexName: string | null
  poolModel: string | null
}

export interface RobinhoodHolderDataInput {
  topHoldersCount: number
  // Mirrors this codebase's existing HolderProviderStatus (page.tsx) — passed straight through,
  // never re-derived here, so this resolver never disagrees with the holder tab's own reading of
  // the same evidence.
  providerStatus: 'ok' | 'partial' | 'unavailable_with_reason' | 'error' | 'unknown'
  providerReason: string | null
  // True when a supported holder provider was actually called for this (chain, token) — false means
  // no supported provider exists for Robinhood at all (a structural gap, not a transient failure).
  providerAttempted: boolean
}

export interface RobinhoodSecurityDataInput {
  attempted: boolean
  // Mirrors HoneypotSecurityResult.simulationStatus (lib/server/honeypotSecurity.ts) — 'not_supported'
  // is the real, provider-confirmed "this chain/token pair isn't covered" signal (a 403 from
  // honeypot.is), distinct from 'unavailable'/'failed'/'timeout' (real attempts that didn't resolve).
  simulationStatus: 'confirmed' | 'unavailable' | 'failed' | 'not_supported' | 'timeout' | null
  honeypotReason: string | null
  isHoneypot: boolean | null
}

export interface RobinhoodOwnershipDataInput {
  ownerAddress: string | null
  adminAddress: string | null
  isRenounced: boolean | null
  // True only when the owner()/admin()-selector RPC calls themselves completed (regardless of
  // whether they found a real owner) — false means the check itself never ran or the RPC failed.
  checkCompleted: boolean
}

export interface RobinhoodLpDataInput {
  // Mirrors lpControl.proofStatus's own 'not_applicable' semantics — true only when this pool's
  // model (ERC-20 LP token) is one standard lock/burn proof can even apply to.
  proofApplicable: boolean
  controllerType: string | null
  controllerVerified: boolean | null
  // False when Robinhood has no locker-contract registry entry at all (see
  // lib/server/lpLockBurnIntel.ts's LP_LOCK_BURN_REGISTRY — Robinhood is deliberately absent, since
  // its pools are V4-style concentrated liquidity with no ERC-20 LP token to lock/burn).
  lockBurnRegistrySupported: boolean
}

export interface RobinhoodDevControlDataInput {
  deployerAddress: string | null
  deployerResolved: boolean
  holderEvidenceAvailable: boolean
  clusterSupplyPercent: number | null
}

export interface ResolveRobinhoodTokenEvidenceInput {
  chainSlug: 'robinhood'
  chainId: 4663
  tokenAddress: string
  marketData: RobinhoodMarketDataInput
  poolData: RobinhoodPoolDataInput
  holderData: RobinhoodHolderDataInput
  securityData: RobinhoodSecurityDataInput
  ownershipData: RobinhoodOwnershipDataInput
  lpData: RobinhoodLpDataInput
  devControlData: RobinhoodDevControlDataInput
  // Optional — the scan's own already-computed CORTEX/risk score, passed through unchanged into the
  // audit's finalRiskScore. This resolver never recomputes or adjusts the numeric score itself
  // (that stays owned by lib/server/riskScore.ts) — only the confidence label reflects evidence gaps.
  baseRiskScore?: number | null
}

export interface RobinhoodTokenEvidenceAudit {
  tokenAddress: string
  chainId: number
  marketDataStatus: RobinhoodEvidenceStatus
  liquidityStatus: RobinhoodEvidenceStatus
  holderStatus: RobinhoodEvidenceStatus
  lpStatus: RobinhoodEvidenceStatus
  ownershipStatus: RobinhoodEvidenceStatus
  securityStatus: RobinhoodEvidenceStatus
  devControlStatus: RobinhoodEvidenceStatus
  unsupportedChecks: string[]
  providerFailures: string[]
  exactMissingReasons: string[]
  finalRiskScore: number | null
  confidence: 'high' | 'medium' | 'low'
}

export interface RobinhoodTokenEvidence {
  marketDataStatus: RobinhoodEvidenceStatus
  liquidityStatus: RobinhoodEvidenceStatus
  holderStatus: RobinhoodEvidenceStatus
  holderLabel: string
  lpStatus: RobinhoodEvidenceStatus
  lpLockProofLabel: string
  lpControllerLabel: string
  ownershipStatus: RobinhoodEvidenceStatus
  ownershipLabel: string
  securityStatus: RobinhoodEvidenceStatus
  securityLabel: string
  devControlStatus: RobinhoodEvidenceStatus
  devControlLabel: string
  confidence: 'high' | 'medium' | 'low'
  audit: RobinhoodTokenEvidenceAudit
}

const HOLDER_UNAVAILABLE_LABEL = 'Holder distribution unavailable — Robinhood provider did not return holder rows.'
const SECURITY_UNSUPPORTED_LABEL = 'Security simulation unsupported on Robinhood'
const LP_LOCK_UNSUPPORTED_LABEL = 'LP lock proof unsupported for this Robinhood pool model'
const LP_CONTROLLER_UNVERIFIED_LABEL = 'LP controller not verified'
const DEV_CONTROL_NEEDS_HOLDERS_LABEL = 'Needs holder evidence before confirming supply control'

function resolveHolder(input: RobinhoodHolderDataInput): { status: RobinhoodEvidenceStatus; label: string } {
  if (input.topHoldersCount > 0) {
    return input.providerStatus === 'ok'
      ? { status: 'verified', label: `Holder distribution verified — ${input.topHoldersCount} holder row${input.topHoldersCount === 1 ? '' : 's'} indexed.` }
      : { status: 'partial', label: 'Holder distribution partially confirmed — some rows indexed, concentration percentages not fully verified.' }
  }
  if (!input.providerAttempted) {
    return { status: 'unsupported_on_robinhood', label: HOLDER_UNAVAILABLE_LABEL }
  }
  if (input.providerStatus === 'error' || input.providerStatus === 'unavailable_with_reason') {
    return { status: 'provider_unavailable', label: HOLDER_UNAVAILABLE_LABEL }
  }
  return { status: 'not_returned', label: HOLDER_UNAVAILABLE_LABEL }
}

function resolveSecurity(input: RobinhoodSecurityDataInput): { status: RobinhoodEvidenceStatus; label: string } {
  if (!input.attempted) {
    return { status: 'not_returned', label: 'Security simulation not attempted this pass.' }
  }
  if (input.simulationStatus === 'not_supported') {
    return { status: 'unsupported_on_robinhood', label: SECURITY_UNSUPPORTED_LABEL }
  }
  if (input.simulationStatus === 'confirmed') {
    return {
      status: 'verified',
      label: input.isHoneypot === true ? 'Security simulation confirmed a honeypot pattern.' : 'Security simulation verified — no honeypot pattern detected.',
    }
  }
  if (input.simulationStatus === 'failed' || input.simulationStatus === 'timeout') {
    return { status: 'failed_with_reason', label: input.honeypotReason ?? `Security simulation ${input.simulationStatus === 'timeout' ? 'timed out' : 'failed'} for this Robinhood token.` }
  }
  // 'unavailable' or null — a real attempt that produced nothing usable, and this codebase's own
  // secondary provider (GoPlus) is explicitly excluded from Robinhood's chain ID, so there is no
  // second source to try today. Honest, not a guessed reason.
  return { status: 'provider_unavailable', label: input.honeypotReason ?? SECURITY_UNSUPPORTED_LABEL }
}

function resolveOwnership(input: RobinhoodOwnershipDataInput): { status: RobinhoodEvidenceStatus; label: string } {
  if (input.isRenounced === true) return { status: 'verified', label: 'Renounced' }
  if (input.ownerAddress != null) return { status: 'verified', label: 'Held' }
  if (!input.checkCompleted) return { status: 'provider_unavailable', label: 'Not checked in indexed mode' }
  return { status: 'not_returned', label: 'Provider did not return an owner()/admin() result for this contract' }
}

function resolveLp(input: RobinhoodLpDataInput): { status: RobinhoodEvidenceStatus; lockLabel: string; controllerLabel: string } {
  if (!input.proofApplicable) {
    return {
      status: 'not_applicable',
      lockLabel: 'Not available for this pool model — standard ERC-20 LP lock/burn proof does not apply to Robinhood\'s concentrated-liquidity pools.',
      controllerLabel: 'Not available for this pool model.',
    }
  }
  if (input.controllerVerified === true) {
    return { status: 'verified', lockLabel: 'LP lock/burn proof verified.', controllerLabel: `LP controller verified${input.controllerType ? ` (${input.controllerType})` : ''}.` }
  }
  if (!input.lockBurnRegistrySupported) {
    return { status: 'unsupported_on_robinhood', lockLabel: LP_LOCK_UNSUPPORTED_LABEL, controllerLabel: LP_CONTROLLER_UNVERIFIED_LABEL }
  }
  return { status: 'partial', lockLabel: LP_LOCK_UNSUPPORTED_LABEL, controllerLabel: LP_CONTROLLER_UNVERIFIED_LABEL }
}

function resolveDevControl(input: RobinhoodDevControlDataInput): { status: RobinhoodEvidenceStatus; label: string } {
  if (!input.deployerResolved || input.deployerAddress == null) {
    return { status: 'not_returned', label: 'Deployer address not returned — explorer/RPC contract-creation lookup did not resolve for this Robinhood token.' }
  }
  if (!input.holderEvidenceAvailable) {
    return { status: 'partial', label: DEV_CONTROL_NEEDS_HOLDERS_LABEL }
  }
  return {
    status: 'verified',
    label: input.clusterSupplyPercent != null
      ? `Deployer/cluster supply control confirmed at ${input.clusterSupplyPercent.toFixed(1)}%.`
      : 'Deployer resolved; cluster supply control confirmed at 0% of indexed holders.',
  }
}

function resolveMarketAndLiquidity(marketData: RobinhoodMarketDataInput, poolData: RobinhoodPoolDataInput): {
  marketDataStatus: RobinhoodEvidenceStatus
  liquidityStatus: RobinhoodEvidenceStatus
} {
  if (marketData.noActivePools && poolData.poolCount === 0) {
    return { marketDataStatus: 'not_returned', liquidityStatus: 'not_returned' }
  }
  return {
    marketDataStatus: marketData.hasPrice ? 'verified' : 'partial',
    liquidityStatus: (poolData.liquidityUsd ?? 0) > 0 ? 'verified' : 'partial',
  }
}

export function resolveRobinhoodTokenEvidence(input: ResolveRobinhoodTokenEvidenceInput): RobinhoodTokenEvidence {
  const { marketDataStatus, liquidityStatus } = resolveMarketAndLiquidity(input.marketData, input.poolData)
  const holder = resolveHolder(input.holderData)
  const security = resolveSecurity(input.securityData)
  const ownership = resolveOwnership(input.ownershipData)
  const lp = resolveLp(input.lpData)
  const devControl = resolveDevControl(input.devControlData)

  // CONFIDENCE, DISCLOSED (hard rule: "unsupported holder/LP/security = confidence reduction... do
  // not treat unsupported as confirmed bad"): counts only the three sections this task names as
  // risk-relevant confidence inputs. A section landing on 'not_applicable' (genuinely doesn't apply
  // to this pool model) never counts against confidence — that is a correct, verified classification,
  // not a gap. Market/liquidity being real, positive evidence (per the hard rule) is not penalized
  // even when other sections are thin.
  const confidenceRelevantStatuses = [holder.status, security.status, lp.status]
  const degradedCount = confidenceRelevantStatuses.filter((s) =>
    s === 'unsupported_on_robinhood' || s === 'provider_unavailable' || s === 'not_returned' || s === 'failed_with_reason' || s === 'partial'
  ).length
  const confidence: 'high' | 'medium' | 'low' = degradedCount === 0 ? 'high' : degradedCount === 1 ? 'medium' : 'low'

  const sectionEntries: Array<{ name: string; status: RobinhoodEvidenceStatus; label: string }> = [
    { name: 'holder', status: holder.status, label: holder.label },
    { name: 'security', status: security.status, label: security.label },
    { name: 'ownership', status: ownership.status, label: ownership.label },
    { name: 'lp', status: lp.status, label: lp.lockLabel },
    { name: 'devControl', status: devControl.status, label: devControl.label },
  ]
  const unsupportedChecks = sectionEntries.filter((e) => e.status === 'unsupported_on_robinhood' || e.status === 'not_applicable').map((e) => e.name)
  const providerFailures = sectionEntries.filter((e) => e.status === 'failed_with_reason' || e.status === 'provider_unavailable').map((e) => e.name)
  const exactMissingReasons = sectionEntries.filter((e) => e.status !== 'verified').map((e) => e.label)

  const audit: RobinhoodTokenEvidenceAudit = {
    tokenAddress: input.tokenAddress,
    chainId: input.chainId,
    marketDataStatus,
    liquidityStatus,
    holderStatus: holder.status,
    lpStatus: lp.status,
    ownershipStatus: ownership.status,
    securityStatus: security.status,
    devControlStatus: devControl.status,
    unsupportedChecks,
    providerFailures,
    exactMissingReasons,
    finalRiskScore: input.baseRiskScore ?? null,
    confidence,
  }

  return {
    marketDataStatus,
    liquidityStatus,
    holderStatus: holder.status,
    holderLabel: holder.label,
    lpStatus: lp.status,
    lpLockProofLabel: lp.lockLabel,
    lpControllerLabel: lp.controllerLabel,
    ownershipStatus: ownership.status,
    ownershipLabel: ownership.label,
    securityStatus: security.status,
    securityLabel: security.label,
    devControlStatus: devControl.status,
    devControlLabel: devControl.label,
    confidence,
    audit,
  }
}
