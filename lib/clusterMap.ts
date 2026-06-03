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
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null
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

function riskFromSupply(percent: number | null, suspiciousTransfers: boolean): { score: number | null; label: ClusterMap['summary']['clusterRiskLabel'] } {
  if (percent == null) return { score: suspiciousTransfers ? 55 : null, label: suspiciousTransfers ? 'elevated' : 'open_check' }
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
    nodes.set(node.id, {
      ...existing,
      ...node,
      supplyPercent: existing.supplyPercent ?? node.supplyPercent,
      rank: existing.rank ?? node.rank,
      confidence: existing.confidence === 'high' || node.confidence === 'open_check' ? existing.confidence : node.confidence,
      isCreator: existing.isCreator || node.isCreator,
      isLinked: existing.isLinked || node.isLinked,
      isCluster: existing.isCluster || node.isCluster,
      reasons: Array.from(new Set([...existing.reasons, ...node.reasons])),
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
    upsertNode({
      id: nodeId(holder.address),
      address: holder.address,
      label: `Holder #${holder.rank ?? '?'}`,
      type: 'holder_wallet',
      supplyPercent: holder.percent,
      rank: holder.rank,
      confidence: 'open_check',
      isCreator: false,
      isLinked: false,
      isCluster: false,
      reasons: ['Indexed top holder only; no deployer or linked-wallet evidence confirmed.'],
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

  const nodeList = [...nodes.values()]
  const { score, label } = riskFromSupply(clusterSupplyPercent, Boolean(input.suspiciousTransfers))
  const status: CanonicalStatus = nodeList.length === 0
    ? 'unavailable_with_reason'
    : edges.some((edge) => edge.confidence === 'high') || (clusterSupplyPercent != null && clusterSupplyPercent > 0)
      ? 'verified'
      : edges.length > 0 || Boolean(input.suspiciousTransfers)
        ? 'inferred'
        : holderRows.length > 0 || linkedWallets.length > 0 || deployerAddress
          ? 'partial'
          : 'unavailable_with_reason'
  const reason = nodeList.length === 0
    ? 'No deployer, linked-wallet, or holder evidence is available for a reliable cluster map.'
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
