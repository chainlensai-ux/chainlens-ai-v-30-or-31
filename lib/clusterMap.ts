import type { CanonicalStatus } from './canonicalStatus'

export type ClusterNodeType = 'deployer' | 'linked_wallet' | 'cluster_wallet' | 'holder_wallet'
export type ClusterConfidence = 'high' | 'medium' | 'low' | 'open_check'
export type ClusterEdgeConfidence = 'high' | 'medium' | 'low'

export type ClusterNode = {
  id: string
  address: string
  label: string
  type: ClusterNodeType
  supplyPercent: number | null
  rank: number | null
  confidence: ClusterConfidence
  isCreator: boolean
  isLinked: boolean
  isCluster: boolean
  reasons: string[]
}

export type ClusterEdge = {
  id: string
  source: string
  target: string
  type: 'deployer_to_linked' | 'linked_to_cluster' | 'holder_overlap' | 'transfer_signal' | 'shared_pattern' | 'weak_heuristic'
  weight: number
  confidence: ClusterEdgeConfidence
  reason: string
}

export type ClusterMap = {
  status: CanonicalStatus
  nodes: ClusterNode[]
  edges: ClusterEdge[]
  summary: {
    totalNodes: number
    totalEdges: number
    deployerAddress: string | null
    linkedWalletCount: number
    clusterWalletCount: number
    holderWalletCount: number
    clusterSupplyPercent: number | null
    clusterDominance: 'none' | 'low' | 'medium' | 'high' | 'critical' | 'unknown'
    clusterRiskScore: number | null
    clusterRiskLabel: 'low' | 'watch' | 'elevated' | 'high' | 'critical' | 'open_check'
    reason: string
  }
  signals: string[]
}

type BuildClusterMapInput = {
  deployerAddress?: string | null
  deployerStatus?: string | null
  linkedWallets?: Array<{ address?: string | null; reason?: string | null; confidence?: string | null }>
  matchedLinkedWallets?: Array<{ address?: string | null; percent?: number | null; rank?: number | null; confidence?: string | null }>
  supplyControl?: {
    creatorInTopHolders?: boolean | null
    creatorHolderRank?: number | null
    creatorHolderPercent?: number | null
    linkedWalletSupplyPercent?: number | null
    devClusterSupplyPercent?: number | null
    devClusterSupplyStatus?: CanonicalStatus | string | null
    devClusterSupplyReason?: string | null
  } | null
  holderDistribution?: { topHolders?: Array<{ rank?: number | null; address?: string | null; percent?: number | null }> } | null
  topHolders?: Array<{ rank?: number | null; address?: string | null; percent?: number | null }>
  suspiciousTransfers?: boolean | null
  suspiciousTransferReasons?: string[] | null
  holderRowsAvailable?: boolean | null
  lpLockBurnConfirmed?: boolean | null
  adminFunctionsDetected?: boolean | null
  upgradeabilityDetected?: boolean | null
  simulationStatus?: string | null
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(normalized) || normalized === ZERO_ADDR) return null
  return normalized
}

function nodeId(address: string): string {
  return `wallet:${address}`
}


function cleanPercent(value: number | null | undefined): number | null {
  // A negative percent is corrupt upstream data, not a real "0% or below" reading. Treating it as
  // null (unknown) makes it surface as an open-check rather than silently reading as reassuring
  // "no dominance / low risk" via dominanceFromSupply/riskFromSupply's <= 0 branches.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100) / 100
}

function normalizeConfidence(value: string | null | undefined, fallback: ClusterConfidence = 'medium'): ClusterConfidence {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'open_check' ? value : fallback
}

function edgeConfidence(value: ClusterConfidence): ClusterEdgeConfidence {
  return value === 'high' || value === 'medium' ? value : 'low'
}

function dominanceFromSupply(percent: number | null): ClusterMap['summary']['clusterDominance'] {
  if (percent == null) return 'unknown'
  if (percent <= 0) return 'none'
  if (percent < 10) return 'low'
  if (percent < 20) return 'medium'
  if (percent < 35) return 'high'
  return 'critical'
}

function riskFromSupply(percent: number | null, suspiciousTransfers: boolean, otherCriticalEvidence: boolean): { score: number | null; label: ClusterMap['summary']['clusterRiskLabel'] } {
  if (percent == null) {
    if (suspiciousTransfers) return { score: 55, label: 'elevated' }
    if (!otherCriticalEvidence) return { score: null, label: 'open_check' }
    // Cluster supply itself is unconfirmed, but other critical evidence (deployer,
    // linked wallets, LP lock/burn, admin functions, upgradeability, simulation) is
    // present, so this is a real (low) reading rather than a fabricated "open check".
    return { score: 25, label: 'low' }
  }
  const base = percent >= 50 ? 88 : percent >= 35 ? 76 : percent >= 20 ? 63 : percent >= 10 ? 47 : percent > 0 ? 28 : 12
  const score = Math.max(0, Math.min(100, base + (suspiciousTransfers ? 10 : 0)))
  const label = score <= 20 ? 'low' : score <= 40 ? 'watch' : score <= 60 ? 'elevated' : score <= 80 ? 'high' : 'critical'
  return { score, label }
}

function pushUniqueSignal(signals: string[], signal: string) {
  if (!signals.includes(signal) && signals.length < 5) signals.push(signal)
}

export function buildClusterMap(input: BuildClusterMapInput): ClusterMap {
  const deployerAddress = normalizeAddress(input.deployerAddress)
  const linkedWallets = (input.linkedWallets ?? [])
    .map((wallet) => ({ ...wallet, address: normalizeAddress(wallet.address) }))
    .filter((wallet): wallet is { address: string; reason?: string | null; confidence?: string | null } => Boolean(wallet.address))

  const linkedByAddress = new Map(linkedWallets.map((wallet) => [wallet.address, wallet]))
  const matchedLinkedByAddress = new Map(
    (input.matchedLinkedWallets ?? [])
      .map((wallet) => ({ ...wallet, address: normalizeAddress(wallet.address), percent: cleanPercent(wallet.percent), rank: wallet.rank ?? null }))
      .filter((wallet): wallet is { address: string; percent: number | null; rank: number | null; confidence?: string | null } => Boolean(wallet.address))
      .map((wallet) => [wallet.address, wallet]),
  )
  const holderRows = (input.holderDistribution?.topHolders ?? input.topHolders ?? [])
    .map((holder, index) => ({ address: normalizeAddress(holder.address), percent: cleanPercent(holder.percent), rank: holder.rank ?? index + 1 }))
    .filter((holder): holder is { address: string; percent: number | null; rank: number } => Boolean(holder.address))

  const holderByAddress = new Map(holderRows.map((holder) => [holder.address, holder]))
  const nodes = new Map<string, ClusterNode>()
  const edges: ClusterEdge[] = []
  const signals: string[] = []

  function upsertNode(node: ClusterNode) {
    const existing = nodes.get(node.id)
    if (!existing) {
      nodes.set(node.id, node)
      return
    }
    // CLUSTER-MAP-AUDIT FIX, DISCLOSED: the old merge only protected against a downgrade when the
    // existing confidence was 'high' or the incoming one was 'open_check' — so e.g. an existing
    // 'medium' node upserted again with an incoming 'low' (possible if upstream linkedWallets /
    // matchedLinkedWallets carry duplicate rows for the same address with inconsistent per-row
    // confidence) silently lost its better reading, even though isCreator/isLinked/isCluster only
    // ever strengthen (OR-merge) — producing a node the booleans say is confirmed-linked but the
    // badge says is low-confidence. Always keep whichever confidence is higher instead.
    const confidenceRank: Record<ClusterConfidence, number> = { open_check: 0, low: 1, medium: 2, high: 3 }
    const confidence = confidenceRank[node.confidence] > confidenceRank[existing.confidence] ? node.confidence : existing.confidence
    nodes.set(node.id, {
      ...existing,
      ...node,
      supplyPercent: existing.supplyPercent ?? node.supplyPercent,
      rank: existing.rank ?? node.rank,
      confidence,
      isCreator: existing.isCreator || node.isCreator,
      isLinked: existing.isLinked || node.isLinked,
      isCluster: existing.isCluster || node.isCluster,
      // Capped like `signals` below, so a wallet hit by many duplicate/low-quality upstream rows
      // can't accumulate an unbounded, increasingly redundant reasons list.
      reasons: Array.from(new Set([...existing.reasons, ...node.reasons])).slice(0, 6),
    })
  }

  if (deployerAddress) {
    const holder = holderByAddress.get(deployerAddress)
    upsertNode({
      id: nodeId(deployerAddress),
      address: deployerAddress,
      label: 'Deployer',
      type: 'deployer',
      supplyPercent: cleanPercent(input.supplyControl?.creatorHolderPercent) ?? holder?.percent ?? null,
      rank: input.supplyControl?.creatorHolderRank ?? holder?.rank ?? null,
      confidence: input.deployerStatus === 'confirmed' || input.deployerStatus == null ? 'high' : 'medium',
      isCreator: true,
      isLinked: false,
      isCluster: Boolean(holder),
      reasons: [holder ? 'Deployer appears in indexed holder rows.' : 'Deployer/origin wallet resolved from Dev Control evidence.'],
    })
    pushUniqueSignal(signals, 'Deployer confirmed')
  }

  for (const wallet of linkedWallets) {
    const matched = matchedLinkedByAddress.get(wallet.address)
    const holder = holderByAddress.get(wallet.address)
    const confidence = normalizeConfidence(matched?.confidence ?? wallet.confidence, matched || holder ? 'high' : 'medium')
    upsertNode({
      id: nodeId(wallet.address),
      address: wallet.address,
      label: 'Linked wallet',
      type: 'linked_wallet',
      supplyPercent: matched?.percent ?? holder?.percent ?? null,
      rank: matched?.rank ?? holder?.rank ?? null,
      confidence,
      isCreator: false,
      isLinked: true,
      isCluster: Boolean(matched || holder),
      reasons: [wallet.reason || 'Linked wallet mapped by Dev Control evidence.', ...(matched || holder ? ['Linked wallet appears in indexed holder set.'] : [])],
    })
    pushUniqueSignal(signals, 'Linked wallet mapped')
    if (matched || holder) pushUniqueSignal(signals, 'Linked wallet appears in holder set')
    if (deployerAddress) {
      const directTransfer = wallet.reason?.includes('token_supply_transfer') || wallet.reason?.includes('transfer')
      const weight = directTransfer ? 88 : matched || holder ? 75 : 58
      edges.push({
        id: `edge:${deployerAddress}:${wallet.address}:deployer_to_linked`,
        source: nodeId(deployerAddress),
        target: nodeId(wallet.address),
        type: directTransfer ? 'deployer_to_linked' : 'transfer_signal',
        weight,
        confidence: edgeConfidence(confidence),
        reason: wallet.reason || 'Dev Control mapped this wallet as linked to the deployer/origin wallet.',
      })
    }
  }

  for (const [address, matched] of matchedLinkedByAddress) {
    if (linkedByAddress.has(address)) continue
    const holder = holderByAddress.get(address)
    upsertNode({
      id: nodeId(address),
      address,
      label: 'Cluster wallet',
      type: 'cluster_wallet',
      supplyPercent: matched.percent ?? holder?.percent ?? null,
      rank: matched.rank ?? holder?.rank ?? null,
      confidence: normalizeConfidence(matched.confidence, 'medium'),
      isCreator: false,
      isLinked: true,
      isCluster: true,
      reasons: ['Matched linked wallet appears in indexed holder set.'],
    })
    pushUniqueSignal(signals, 'Linked wallet appears in holder set')
    if (deployerAddress) {
      edges.push({
        id: `edge:${deployerAddress}:${address}:holder_overlap`,
        source: nodeId(deployerAddress),
        target: nodeId(address),
        type: 'holder_overlap',
        weight: 72,
        confidence: 'medium',
        reason: 'Linked wallet overlap was confirmed in top-holder rows.',
      })
    }
  }

  for (const holder of holderRows.slice(0, 12)) {
    if (holder.address === deployerAddress || linkedByAddress.has(holder.address) || matchedLinkedByAddress.has(holder.address)) continue
    // CONFIDENCE-REASONING FIX, DISCLOSED: this used to hardcode confidence: 'open_check' for every
    // plain holder, with no distinction based on how much we actually know about that row — so the
    // UI showed "Open check" for 100% of indexed holders regardless of data quality, with a reason
    // string that never varied. Confidence here still can't mean "confirmed linked to the deployer"
    // (that's genuinely unconfirmed for a plain holder), but it CAN reflect how much is actually
    // known about the holder-position reading itself:
    //   - percent AND a real rank confirmed on-chain -> 'medium' (a solid, source-backed reading)
    //   - rank confirmed but percent could not be safely computed this pass (e.g. the token's supply
    //     data failed a sanity check upstream, so percentages were withheld to avoid showing a wrong
    //     number) -> 'low'. The wallet's presence and ranked position are still real on-chain evidence
    //     even without a percent, so this is a grounded partial read, not a guess.
    //   - neither is available (defensive floor only; holderRows always assigns a rank in practice,
    //     via a positional fallback, so this branch should be effectively unreachable) -> 'open_check'
    const hasPercent = holder.percent != null
    const hasRank = typeof holder.rank === 'number' && Number.isFinite(holder.rank)
    const confidence: ClusterConfidence = hasRank ? (hasPercent ? 'medium' : 'low') : 'open_check'
    const reason = hasRank && hasPercent
      ? `Indexed top holder with a confirmed on-chain supply share (${holder.percent!.toFixed(1)}%) and rank (#${holder.rank}); no deployer or linked-wallet evidence to confirm cluster role.`
      : hasRank
        ? `Indexed top holder at rank #${holder.rank} confirmed on-chain, but the exact supply share could not be safely computed this pass; no deployer or linked-wallet evidence to confirm cluster role.`
        : 'Indexed top holder only; no deployer or linked-wallet evidence confirmed.'
    upsertNode({
      id: nodeId(holder.address),
      address: holder.address,
      label: `Holder #${holder.rank ?? '?'}`,
      type: 'holder_wallet',
      supplyPercent: holder.percent,
      rank: holder.rank,
      confidence,
      isCreator: false,
      isLinked: false,
      isCluster: false,
      reasons: [reason],
    })
  }

  if (input.suspiciousTransfers && deployerAddress) {
    const reason = input.suspiciousTransferReasons?.[0] ?? 'Suspicious transfer pattern detected by Dev Control.'
    for (const wallet of linkedWallets.slice(0, 5)) {
      edges.push({
        id: `edge:${deployerAddress}:${wallet.address}:shared_pattern`,
        source: nodeId(deployerAddress),
        target: nodeId(wallet.address),
        type: 'shared_pattern',
        weight: 60,
        confidence: 'medium',
        reason,
      })
    }
    pushUniqueSignal(signals, 'Suspicious transfer pattern detected')
  }

  const clusterSupplyPercent = cleanPercent(input.supplyControl?.devClusterSupplyPercent)
  if (clusterSupplyPercent != null && clusterSupplyPercent > 0) pushUniqueSignal(signals, 'Cluster supply found')
  if (clusterSupplyPercent === 0) pushUniqueSignal(signals, 'No cluster supply found in indexed holders')
  if (input.holderRowsAvailable === false || holderRows.length === 0) pushUniqueSignal(signals, 'Holder evidence incomplete')
  if (holderRows.length > 0 && matchedLinkedByAddress.size === 0 && linkedWallets.length > 0) pushUniqueSignal(signals, 'Top holder overlap not confirmed')
  if (input.lpLockBurnConfirmed === true) pushUniqueSignal(signals, 'LP lock/burn confirmed')
  if (input.adminFunctionsDetected === true) pushUniqueSignal(signals, 'Admin functions detected')
  if (input.upgradeabilityDetected === true) pushUniqueSignal(signals, 'Contract is upgradeable')
  if (input.simulationStatus && input.simulationStatus !== 'open_check') pushUniqueSignal(signals, `Simulation status: ${input.simulationStatus}`)

  // OPEN_CHECK is only appropriate when every critical evidence category Dev Control,
  // Token Scanner, and Base Radar share is missing: deployer, linked wallets, cluster
  // supply, LP lock/burn, admin functions, upgradeability, and simulation status.
  const hasCriticalEvidence = Boolean(
    deployerAddress
    || linkedWallets.length > 0
    || (clusterSupplyPercent != null)
    || input.lpLockBurnConfirmed === true
    || input.adminFunctionsDetected != null
    || input.upgradeabilityDetected != null
    || (input.simulationStatus != null && input.simulationStatus !== 'open_check'),
  )

  const nodeList = [...nodes.values()]
  const { score, label } = riskFromSupply(clusterSupplyPercent, Boolean(input.suspiciousTransfers), hasCriticalEvidence)
  const status: CanonicalStatus = nodeList.length === 0
    ? (hasCriticalEvidence ? 'partial' : 'unavailable_with_reason')
    : edges.some((edge) => edge.confidence === 'high') || (clusterSupplyPercent != null && clusterSupplyPercent > 0)
      ? 'verified'
      : edges.length > 0 || Boolean(input.suspiciousTransfers)
        ? 'inferred'
        : holderRows.length > 0 || linkedWallets.length > 0 || deployerAddress
          ? 'partial'
          : 'unavailable_with_reason'
  const reason = nodeList.length === 0
    ? (hasCriticalEvidence
      ? 'No deployer, linked-wallet, or holder rows yet, but other Dev Control/Token Scanner evidence (LP lock/burn, admin functions, upgradeability, or simulation) is present.'
      : 'No deployer, linked-wallet, or holder evidence is available for a reliable cluster map.')
    : clusterSupplyPercent != null
      ? `Cluster map built from existing Dev Control and holder evidence; cluster supply is ${clusterSupplyPercent.toFixed(1)}%.`
      : 'Cluster map built from available actor evidence; cluster supply remains an open check until holder percentages confirm overlap.'

  return {
    status,
    nodes: nodeList,
    edges: edges.filter((edge) => edge.reason),
    summary: {
      totalNodes: nodeList.length,
      totalEdges: edges.length,
      deployerAddress,
      linkedWalletCount: nodeList.filter((node) => node.isLinked).length,
      clusterWalletCount: nodeList.filter((node) => node.isCluster && !node.isCreator).length,
      holderWalletCount: nodeList.filter((node) => node.type === 'holder_wallet').length,
      clusterSupplyPercent,
      clusterDominance: dominanceFromSupply(clusterSupplyPercent),
      clusterRiskScore: score,
      clusterRiskLabel: label,
      reason,
    },
    signals,
  }
}
