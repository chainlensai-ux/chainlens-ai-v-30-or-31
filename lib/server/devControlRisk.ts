export type DevControlRiskLabel = 'low' | 'watch' | 'elevated' | 'high' | 'critical'

export type DevControlRiskInput = {
  clusterSupplyPercent?: number | null
  linkedWalletSupplyPercent?: number | null
  creatorHolderPercent?: number | null
  top10Percent?: number | null
  top20Percent?: number | null
  creatorInTopHolders?: boolean | null
  deployerInTopHolders?: boolean | null
  suspiciousDeployer?: boolean | null
  suspiciousPastLaunches?: boolean | null
  rugHistoryFlag?: boolean | null
  holderEvidencePartial?: boolean | null
}

function finitePct(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

export function getDevControlRiskLabel(score: number): DevControlRiskLabel {
  if (score <= 20) return 'low'
  if (score <= 40) return 'watch'
  if (score <= 60) return 'elevated'
  if (score <= 80) return 'high'
  return 'critical'
}

export function calculateDevControlRisk(input: DevControlRiskInput): { score: number; label: DevControlRiskLabel; reason: string; signals: string[] } {
  const clusterSupplyPercent = finitePct(input.clusterSupplyPercent) ?? 0
  const linkedWalletSupplyPercent = finitePct(input.linkedWalletSupplyPercent) ?? 0
  const creatorHolderPercent = finitePct(input.creatorHolderPercent) ?? 0
  const top10Percent = finitePct(input.top10Percent)
  const top20Percent = finitePct(input.top20Percent)
  let score = 5
  const signals: string[] = []

  if (clusterSupplyPercent > 0 && clusterSupplyPercent <= 1) score = Math.max(score, 15)
  if (clusterSupplyPercent > 1 && clusterSupplyPercent <= 5) score = Math.max(score, 30)
  if (clusterSupplyPercent > 5 && clusterSupplyPercent <= 10) score = Math.max(score, 50)
  if (clusterSupplyPercent > 10 && clusterSupplyPercent <= 20) score = Math.max(score, 70)
  if (clusterSupplyPercent > 20) score = Math.max(score, 90)
  signals.push(clusterSupplyPercent > 0 ? `Cluster supply contributes ${clusterSupplyPercent.toFixed(1)}%.` : 'Cluster supply is 0% in indexed holders.')

  if (linkedWalletSupplyPercent >= 1) score = Math.max(score, 25)
  if (linkedWalletSupplyPercent >= 5) score = Math.max(score, 45)
  if (linkedWalletSupplyPercent >= 10) score = Math.max(score, 65)
  signals.push(linkedWalletSupplyPercent > 0 ? `Linked wallet supply contributes ${linkedWalletSupplyPercent.toFixed(1)}%.` : 'No linked-wallet supply found in indexed holders.')

  if (creatorHolderPercent >= 1) score = Math.max(score, 20)
  if (creatorHolderPercent >= 5) score = Math.max(score, 45)
  if (creatorHolderPercent >= 10) score = Math.max(score, 65)
  signals.push(creatorHolderPercent > 0 ? `Creator holder supply contributes ${creatorHolderPercent.toFixed(1)}%.` : 'Creator wallet not found in indexed top holders.')

  if (top10Percent != null) {
    if (top10Percent >= 40) score = Math.max(score, 35)
    if (top10Percent >= 50) score = Math.max(score, 50)
    if (top10Percent >= 70) score = Math.max(score, 75)
    signals.push(`Top 10 holders control ${top10Percent.toFixed(1)}%.`)
  }
  if (top20Percent != null) {
    if (top20Percent >= 60) score = Math.max(score, 40)
    if (top20Percent >= 75) score = Math.max(score, 60)
    if (top20Percent >= 90) score = Math.max(score, 80)
    signals.push(`Top 20 holders control ${top20Percent.toFixed(1)}%.`)
  }

  if (input.creatorInTopHolders) {
    score = Math.max(score, 45)
    signals.push('Creator wallet appears in indexed top holders.')
  }
  if (input.deployerInTopHolders) {
    score = Math.max(score, 45)
    signals.push('Deployer wallet appears in indexed top holders.')
  }
  if (input.suspiciousDeployer || input.suspiciousPastLaunches || input.rugHistoryFlag) {
    score = Math.max(score, 70)
    signals.push('Suspicious deployer or launch-history evidence is present.')
  }
  if (input.holderEvidencePartial && score < 30) {
    score = 30
    signals.push('Holder evidence is partial, preventing a false minimal score.')
  } else if (input.holderEvidencePartial) {
    signals.push('Holder evidence is partial.')
  }

  let reason = 'No cluster dominance found; risk remains low.'
  if (clusterSupplyPercent === 0 && top20Percent != null && top20Percent >= 60) reason = `Cluster supply is 0%, but top 20 holders control ${top20Percent.toFixed(1)}%, so supply control risk is not minimal.`
  else if (clusterSupplyPercent === 0 && top10Percent != null && top10Percent >= 40) reason = 'Cluster supply is 0%, but top-holder concentration is elevated.'
  else if (linkedWalletSupplyPercent === 0 && input.holderEvidencePartial) reason = 'No linked-wallet supply found, but holder evidence is partial.'
  else if (!input.creatorInTopHolders && creatorHolderPercent === 0) reason = 'Creator wallet not found in indexed top holders.'
  else if (clusterSupplyPercent > 0) reason = `${clusterSupplyPercent.toFixed(1)}% dev-control cluster supply found in indexed holders.`

  const rounded = Math.max(0, Math.min(100, Math.round(score)))
  return { score: rounded, label: getDevControlRiskLabel(rounded), reason, signals: signals.slice(0, 8) }
}
