// DEPLOYER WALLET INTEL RESOLVER, DISCLOSED (Cluster Map deployer wallet detail fix). Root cause of
// the reported bug: the Cluster Map "Wallet Detail" panel rendered raw `ClusterNode` fields
// (supplyPercent/rank/confidence) straight from `buildClusterMap()` — a thin, lossy transform that
// drops most of the richer deployer evidence Dev Control (`/api/dev-wallet`) already computes
// (un-truncated top-holder rows, supplyControl.creatorHolderRank/Percent, linkedWallets with
// amountReceived/firstSeen/txHash, previousProjects). The address was always known; the panel just
// never consulted the evidence that already existed. This resolver is a pure, synchronous, no-network
// function that assembles a richer deployer intel record from data the caller already has in hand
// (existing scanner result, Dev Control result, holder snapshot, cluster transfer edges) — following
// the exact 7-step resolution order specified for this fix. It NEVER invents a supply position or a
// transfer link: every field is either read directly from evidence or explicitly marked
// unknown/unavailable with a stated reason. The one genuinely new capability (a live "current token
// balance" RPC/indexer call) is intentionally kept OUTSIDE this function — callers pass its result in
// via `cheapBalance`/`nativeBalance` once resolved — so this resolver itself never triggers network
// I/O and can never accidentally trigger the full, expensive Wallet Scanner.

export type YesNoUnknown = 'yes' | 'no' | 'unknown'
export type DeployerIntelConfidence = 'high' | 'medium' | 'low' | 'open_check'

export interface DeployerIntelHolderRow {
  address: string
  rank?: number | null
  percent?: number | null
  amount?: string | number | null
}

export interface DeployerIntelHolderSnapshot {
  chain?: string | null
  available: boolean
  topHolders: DeployerIntelHolderRow[]
}

export interface DeployerIntelTransferEdge {
  source: string
  target: string
  type: string
  reason: string
  confidence?: 'high' | 'medium' | 'low'
}

export interface DeployerIntelClusterMap {
  nodes: Array<{ address: string; id: string }>
  edges?: DeployerIntelTransferEdge[]
}

export interface DeployerIntelLinkedWallet {
  address: string
  amountReceived?: number | null
  asset?: string | null
  firstSeen?: string | null
  txHash?: string | null
  reason?: string | null
  confidence?: 'high' | 'medium' | 'low' | string | null
}

export interface DeployerIntelPreviousProject {
  contractAddress: string
  name: string | null
  symbol: string | null
  createdAt: string | null
  rugFlag: boolean | null
}

export interface DeployerIntelDevControlResult {
  chain?: string | null
  supplyControl?: {
    creatorInTopHolders?: boolean | null
    creatorHolderRank?: number | null
    creatorHolderPercent?: number | null
  } | null
  linkedWallets?: DeployerIntelLinkedWallet[] | null
  previousActivityAvailable?: boolean | null
  previousActivityStatus?: string | null
  previousProjects?: DeployerIntelPreviousProject[] | null
  suspiciousTransfers?: boolean | null
  suspiciousTransferReasons?: string[] | null
}

export interface DeployerIntelCheapBalanceResult {
  attempted: boolean
  succeeded: boolean
  balance?: number | null
  reason?: string | null
}

export interface DeployerIntelNativeBalanceResult {
  attempted: boolean
  succeeded: boolean
  amount?: number | null
  asset?: string | null
}

export interface ResolveDeployerWalletIntelInput {
  chainSlug: string
  chainId?: number | string | null
  tokenAddress: string
  tokenSymbol?: string | null
  tokenName?: string | null
  deployerAddress: string | null
  existingScannerResult?: {
    deployerAddress?: string | null
    deployerConfidence?: 'high' | 'medium' | 'low' | null
  } | null
  holderSnapshot?: DeployerIntelHolderSnapshot | null
  transferEdges?: DeployerIntelTransferEdge[] | null
  clusterMap?: DeployerIntelClusterMap | null
  devControlResult?: DeployerIntelDevControlResult | null
  cheapBalance?: DeployerIntelCheapBalanceResult | null
  nativeBalance?: DeployerIntelNativeBalanceResult | null
}

export interface DeployerWalletIntel {
  deployerAddress: string
  chain: string
  tokenDeployed: string
  isCurrentHolder: YesNoUnknown
  currentTokenBalance: number | null
  currentSupplyPercent: number | null
  supplyLabel: string
  holderRank: number | null
  holderRankLabel: string
  deployerNativeBalance: { amount: number | null; asset: string | null; available: boolean }
  receivedSupplyAtLaunch: YesNoUnknown
  transferredOrSold: YesNoUnknown
  linkedWallets: DeployerIntelLinkedWallet[]
  relatedDeployments: DeployerIntelPreviousProject[]
  relatedDeploymentsLabel: string
  behaviorPatternLabel: string
  transferLinksLabel: string
  riskSignals: string[]
  evidenceSource: string[]
  confidence: DeployerIntelConfidence
  nextActions: string[]
}

export interface DeployerWalletIntelAudit {
  chainSlug: string
  chainId: number | string | null
  tokenAddress: string
  deployerAddress: string | null
  holderSnapshotAvailable: boolean
  holderRowsChecked: number
  deployerFoundInHolders: boolean
  deployerBalance: number | null
  deployerSupplyPercent: number | null
  deployerHolderRank: number | null
  transferEdgesChecked: number
  linkedWalletsFound: number
  relatedDeploymentsChecked: number
  cheapBalanceCallAttempted: boolean
  cheapBalanceCallSucceeded: boolean
  confidence: DeployerIntelConfidence
  missingReasons: string[]
}

export interface DeployerWalletIntelResult {
  intel: DeployerWalletIntel
  audit: DeployerWalletIntelAudit
}

function addrEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

// WRONG-CHAIN GUARD, DISCLOSED: holder/dev-control evidence carries its own `chain` when the caller
// has it; if it names a different chain than the token actually resolved on, it is rejected outright
// rather than silently mixed in — a hard rule of this fix ("Do NOT use wrong-chain data").
function chainMatches(evidenceChain: string | null | undefined, chainSlug: string): boolean {
  if (!evidenceChain) return true
  return evidenceChain.toLowerCase() === chainSlug.toLowerCase()
}

export function resolveDeployerWalletIntel(input: ResolveDeployerWalletIntelInput): DeployerWalletIntelResult {
  const missingReasons: string[] = []
  const evidenceSource: string[] = []
  const deployerAddress = input.deployerAddress ?? input.existingScannerResult?.deployerAddress ?? null

  if (!deployerAddress) {
    const emptyIntel: DeployerWalletIntel = {
      deployerAddress: '',
      chain: input.chainSlug,
      tokenDeployed: input.tokenSymbol ?? input.tokenName ?? input.tokenAddress,
      isCurrentHolder: 'unknown',
      currentTokenBalance: null,
      currentSupplyPercent: null,
      supplyLabel: 'Holder data unavailable',
      holderRank: null,
      holderRankLabel: 'Holder list unavailable',
      deployerNativeBalance: { amount: null, asset: null, available: false },
      receivedSupplyAtLaunch: 'unknown',
      transferredOrSold: 'unknown',
      linkedWallets: [],
      relatedDeployments: [],
      relatedDeploymentsLabel: 'Deployer address unresolved — related deployments unavailable.',
      behaviorPatternLabel: 'No wallet behavior pattern confirmed in this pass.',
      transferLinksLabel: 'No transfer links found in current cluster map.',
      riskSignals: [],
      evidenceSource: [],
      confidence: 'open_check',
      nextActions: ['Deployer address not resolved for this token.'],
    }
    return {
      intel: emptyIntel,
      audit: {
        chainSlug: input.chainSlug,
        chainId: input.chainId ?? null,
        tokenAddress: input.tokenAddress,
        deployerAddress: null,
        holderSnapshotAvailable: Boolean(input.holderSnapshot?.available),
        holderRowsChecked: 0,
        deployerFoundInHolders: false,
        deployerBalance: null,
        deployerSupplyPercent: null,
        deployerHolderRank: null,
        transferEdgesChecked: 0,
        linkedWalletsFound: 0,
        relatedDeploymentsChecked: 0,
        cheapBalanceCallAttempted: false,
        cheapBalanceCallSucceeded: false,
        confidence: 'open_check',
        missingReasons: ['deployer_address_unresolved'],
      },
    }
  }

  // Step 2 — Dev Control deployer/linked-wallet + supply-control evidence (chain-checked).
  const devControl = input.devControlResult && chainMatches(input.devControlResult.chain, input.chainSlug)
    ? input.devControlResult
    : null
  if (input.devControlResult && !devControl) missingReasons.push('dev_control_evidence_wrong_chain_rejected')

  let holderRank: number | null = null
  let supplyPercent: number | null = null
  let deployerFoundInHolders = false
  let holderRowsChecked = 0
  const holderSnapshotAvailable = Boolean(input.holderSnapshot?.available) && chainMatches(input.holderSnapshot?.chain, input.chainSlug)
  if (input.holderSnapshot && !holderSnapshotAvailable && input.holderSnapshot.available) {
    missingReasons.push('holder_snapshot_wrong_chain_rejected')
  }

  // Step 2 (preferred): Dev Control's supplyControl is computed against un-truncated holder rows —
  // prefer it over the (possibly 10-row-truncated) public holder snapshot.
  if (devControl?.supplyControl && (devControl.supplyControl.creatorHolderRank != null || devControl.supplyControl.creatorHolderPercent != null || devControl.supplyControl.creatorInTopHolders)) {
    holderRank = devControl.supplyControl.creatorHolderRank ?? null
    supplyPercent = devControl.supplyControl.creatorHolderPercent ?? null
    deployerFoundInHolders = Boolean(devControl.supplyControl.creatorInTopHolders) || holderRank != null || supplyPercent != null
    if (deployerFoundInHolders) evidenceSource.push('dev_control_supply_control')
  }

  // Step 3 — fall back to the holder snapshot / top-holders row list when Dev Control didn't resolve it.
  if (!deployerFoundInHolders && input.holderSnapshot) {
    holderRowsChecked = input.holderSnapshot.topHolders.length
    if (holderSnapshotAvailable) {
      const row = input.holderSnapshot.topHolders.find(h => addrEq(h.address, deployerAddress))
      if (row) {
        deployerFoundInHolders = true
        holderRank = row.rank ?? null
        supplyPercent = row.percent ?? null
        evidenceSource.push('holder_snapshot')
      }
    }
  }

  // Step 5 — cheap live balance call, when the caller already ran (and resolved) one. The raw balance
  // is base-unit (no ERC-20 `decimals()` applied — a second RPC call this cheap path deliberately
  // skips), so it is used only as a >0/=0 presence signal (isCurrentHolder, audit fields) — never
  // rendered as a scaled "X tokens" figure, which would misrepresent magnitude by up to 10^18x and
  // violate the "do NOT invent supply position" hard rule.
  const cheapBalance = input.cheapBalance ?? null
  let currentTokenBalance: number | null = null
  if (cheapBalance?.succeeded && typeof cheapBalance.balance === 'number') {
    currentTokenBalance = cheapBalance.balance
    evidenceSource.push('live_balance_call')
  }

  // Supply/holder-rank labels — exact wording variants required by this fix.
  let supplyLabel: string
  if (deployerFoundInHolders && supplyPercent != null) {
    supplyLabel = `Holds ${supplyPercent.toFixed(2)}% of supply`
  } else if (!holderSnapshotAvailable && !devControl?.supplyControl) {
    supplyLabel = 'Holder data unavailable'
  } else if (deployerFoundInHolders) {
    supplyLabel = 'No indexed balance found'
  } else {
    supplyLabel = 'Outside indexed holder sample'
  }

  let holderRankLabel: string
  if (holderRank != null) {
    holderRankLabel = `Rank #${holderRank} in indexed holders`
  } else if (!holderSnapshotAvailable && !devControl?.supplyControl) {
    holderRankLabel = 'Holder list unavailable'
  } else if (deployerFoundInHolders) {
    holderRankLabel = 'Not checked — run deployer wallet scan'
  } else {
    holderRankLabel = 'Not in indexed top holders'
  }

  // Step 4 — cluster transfer edges (deployer↔other-wallet edges already found by the graph builder).
  const edges = input.transferEdges ?? input.clusterMap?.edges ?? []
  const deployerEdges = edges.filter(e => addrEq(e.source, deployerAddress) || addrEq(e.target, deployerAddress))
  let transferLinksLabel: string
  const linkedFromEdges: DeployerIntelLinkedWallet[] = deployerEdges.map(e => ({
    address: addrEq(e.source, deployerAddress) ? e.target : e.source,
    reason: e.reason,
    confidence: e.confidence,
  }))
  if (deployerEdges.length > 0) {
    transferLinksLabel = `${deployerEdges.length} transfer link${deployerEdges.length === 1 ? '' : 's'} found — see linked wallets below.`
    evidenceSource.push('cluster_transfer_edges')
  } else {
    transferLinksLabel = 'No transfer links found in current cluster map.'
  }

  // Dev Control's own richer LinkedWallet list (amountReceived/firstSeen/txHash) — merged with (not
  // replacing) the graph-edge-derived list above, de-duplicated by address.
  const devLinkedWallets = devControl?.linkedWallets ?? []
  if (devLinkedWallets.length > 0) evidenceSource.push('dev_control_linked_wallets')
  const linkedByAddress = new Map<string, DeployerIntelLinkedWallet>()
  for (const lw of linkedFromEdges) linkedByAddress.set(lw.address.toLowerCase(), lw)
  for (const lw of devLinkedWallets) {
    const key = lw.address.toLowerCase()
    linkedByAddress.set(key, { ...linkedByAddress.get(key), ...lw })
  }
  const linkedWallets = Array.from(linkedByAddress.values())

  const deployerSentTransfer = deployerEdges.some(e => addrEq(e.source, deployerAddress))
  const deployerReceivedTransfer = devLinkedWallets.some(lw => lw.reason === 'token_supply_transfer' && lw.amountReceived != null)

  // These two yes/no/unknown fields are deliberately conservative — the hard rule is "do NOT fake
  // transfer links" / "do NOT invent supply position", so each is only 'yes' when direct evidence
  // supports it and 'unknown' (never a guessed 'no') absent that evidence.
  const receivedSupplyAtLaunch: YesNoUnknown = deployerReceivedTransfer || (deployerFoundInHolders && (supplyPercent ?? 0) > 0)
    ? 'yes'
    : 'unknown'
  const transferredOrSold: YesNoUnknown = deployerSentTransfer || Boolean(devControl?.suspiciousTransfers)
    ? 'yes'
    : 'unknown'

  const isCurrentHolder: YesNoUnknown =
    (currentTokenBalance != null && currentTokenBalance > 0) || (deployerFoundInHolders && (supplyPercent ?? 0) > 0)
      ? 'yes'
      : (cheapBalance?.succeeded && currentTokenBalance === 0) || (deployerFoundInHolders === false && holderSnapshotAvailable && cheapBalance?.succeeded && currentTokenBalance === 0)
        ? 'no'
        : 'unknown'

  // Step 6 — cached related deployments (Dev Control's previousProjects), chain-checked already above.
  const relatedDeployments = devControl?.previousProjects ?? []
  let relatedDeploymentsLabel: string
  if (relatedDeployments.length > 0) {
    evidenceSource.push('dev_control_previous_projects')
    const rugCount = relatedDeployments.filter(p => p.rugFlag).length
    relatedDeploymentsLabel = rugCount > 0
      ? `${relatedDeployments.length} related deployment${relatedDeployments.length === 1 ? '' : 's'} found (${rugCount} flagged).`
      : `${relatedDeployments.length} related deployment${relatedDeployments.length === 1 ? '' : 's'} found.`
  } else if (devControl?.previousActivityAvailable === false) {
    relatedDeploymentsLabel = 'Related deployments unavailable in this pass.'
  } else {
    relatedDeploymentsLabel = 'No related deployments found in cached evidence.'
  }

  const riskSignals: string[] = []
  if (devControl?.suspiciousTransfers) riskSignals.push(...(devControl.suspiciousTransferReasons ?? ['Suspicious transfer pattern detected.']))
  if (supplyPercent != null && supplyPercent >= 20) riskSignals.push(`Deployer holds ${supplyPercent.toFixed(1)}% of supply.`)
  const rugFlaggedDeployments = relatedDeployments.filter(p => p.rugFlag)
  if (rugFlaggedDeployments.length > 0) riskSignals.push(`${rugFlaggedDeployments.length} previous deployment(s) flagged for rug behavior.`)

  const behaviorPatternLabel = deployerSentTransfer
    ? 'Deployer transferred tokens to linked wallets — see transfer links below.'
    : deployerFoundInHolders
      ? 'No outbound transfer signal detected from indexed evidence.'
      : 'No wallet behavior pattern confirmed in this pass.'

  // Confidence: 'high' only when both holder position AND transfer-edge evidence are resolved from
  // real data; 'open_check' only when we have neither snapshot nor Dev Control evidence at all.
  const hasAnyHolderEvidence = deployerFoundInHolders || holderSnapshotAvailable || Boolean(devControl?.supplyControl)
  const hasAnyTransferEvidence = edges.length > 0 || devLinkedWallets.length > 0
  const confidence: DeployerIntelConfidence =
    !hasAnyHolderEvidence && !hasAnyTransferEvidence
      ? 'open_check'
      : deployerFoundInHolders && hasAnyTransferEvidence
        ? 'high'
        : hasAnyHolderEvidence || hasAnyTransferEvidence
          ? 'medium'
          : 'low'

  if (!holderSnapshotAvailable && !devControl?.supplyControl) missingReasons.push('holder_evidence_unavailable')
  if (edges.length === 0 && devLinkedWallets.length === 0) missingReasons.push('no_transfer_edges_found')
  if (!cheapBalance || !cheapBalance.attempted) missingReasons.push('cheap_balance_call_not_attempted')

  const nextActions: string[] = []
  if (confidence !== 'high') nextActions.push('Run Deployer Wallet Scan for full wallet history.')
  if (relatedDeployments.length === 0 && devControl?.previousActivityAvailable !== false) nextActions.push('Check Related Deployments for other tokens by this deployer.')
  if (nextActions.length === 0) nextActions.push('No further action needed — evidence is already high-confidence.')

  const audit: DeployerWalletIntelAudit = {
    chainSlug: input.chainSlug,
    chainId: input.chainId ?? null,
    tokenAddress: input.tokenAddress,
    deployerAddress,
    holderSnapshotAvailable,
    holderRowsChecked,
    deployerFoundInHolders,
    deployerBalance: currentTokenBalance,
    deployerSupplyPercent: supplyPercent,
    deployerHolderRank: holderRank,
    transferEdgesChecked: edges.length,
    linkedWalletsFound: linkedWallets.length,
    relatedDeploymentsChecked: relatedDeployments.length,
    cheapBalanceCallAttempted: Boolean(cheapBalance?.attempted),
    cheapBalanceCallSucceeded: Boolean(cheapBalance?.succeeded),
    confidence,
    missingReasons,
  }

  const intel: DeployerWalletIntel = {
    deployerAddress,
    chain: input.chainSlug,
    tokenDeployed: input.tokenSymbol ?? input.tokenName ?? input.tokenAddress,
    isCurrentHolder,
    currentTokenBalance,
    currentSupplyPercent: supplyPercent,
    supplyLabel,
    holderRank,
    holderRankLabel,
    deployerNativeBalance: {
      amount: input.nativeBalance?.succeeded ? (input.nativeBalance.amount ?? null) : null,
      asset: input.nativeBalance?.asset ?? null,
      available: Boolean(input.nativeBalance?.succeeded),
    },
    receivedSupplyAtLaunch,
    transferredOrSold,
    linkedWallets,
    relatedDeployments,
    relatedDeploymentsLabel,
    behaviorPatternLabel,
    transferLinksLabel,
    riskSignals,
    evidenceSource,
    confidence,
    nextActions,
  }

  return { intel, audit }
}
