// SOLANA DEVELOPER SCORE, DISCLOSED (Dev Intelligence "Developer Score" tab follow-up task).
//
// Replaces a flat, unexplained score with a real composite built from every other Solana-native
// signal this engine gathers — creator confidence, authority state, supply safety, cluster/funding
// confidence, and pattern analysis. Every point on the breakdown cites the exact evidence it came
// from, per this task's own requirement ("every point must be explainable"). Components that were
// never run (e.g. Deep Cluster Check not requested) contribute 0 points with an explicit reason —
// never a guessed/default score.

import type { SolanaCreatorConfidence } from './creatorConfidenceAnalyzer.ts'
import type { SolanaSupplyControl } from './supplyControlAnalyzer.ts'
import type { SolanaClusterMap } from './clusterAnalyzer.ts'
import type { SolanaPatternAnalysis } from './patternAnalyzer.ts'

export type SolanaDeveloperScoreComponent = {
  label: string
  points: number
  maxPoints: number
  reason: string
  /** True when this component never ran (e.g. Deep Cluster Check not requested) — excluded from scaledMaxScore so an un-run check never silently caps every normal scan's score. */
  skipped?: boolean
}

export type SolanaDeveloperScore = {
  score: number
  maxScore: number
  /** Sum of maxPoints across components that actually ran, excluding skipped ones like Cluster/Funding Confidence when Deep Cluster Check was never requested. This is the denominator score is scaled against — never penalize a scan for evidence it never had the chance to collect. */
  scaledMaxScore: number
  components: SolanaDeveloperScoreComponent[]
}

export function buildSolanaDeveloperScore(input: {
  creatorConfidence: SolanaCreatorConfidence
  supplyControl: SolanaSupplyControl
  authorityReadSucceeded: boolean
  freezeAuthority: string | null
  clusterMap: SolanaClusterMap | null
  patterns: SolanaPatternAnalysis
}): SolanaDeveloperScore {
  const { creatorConfidence, supplyControl, authorityReadSucceeded, freezeAuthority, clusterMap, patterns } = input
  const components: SolanaDeveloperScoreComponent[] = []

  // ── Creator confidence (0-30) ────────────────────────────────────────────────────────────────
  const creatorPoints = Math.round((creatorConfidence.confidencePercent / 100) * 30)
  components.push({ label: 'Creator Confidence', points: creatorPoints, maxPoints: 30, reason: `${creatorConfidence.tier} — ${creatorConfidence.reason}` })

  // ── Authority safety (0-30): mint + freeze revoked ───────────────────────────────────────────
  let authorityPoints = 0
  let authorityReason: string
  if (!authorityReadSucceeded) {
    authorityReason = 'Mint/freeze authority could not be read — treated as unknown, not safe.'
  } else {
    const mintRevoked = !supplyControl.mintAuthority
    const freezeRevoked = !freezeAuthority
    authorityPoints = (mintRevoked ? 15 : 0) + (freezeRevoked ? 15 : 0)
    authorityReason = `Mint authority ${mintRevoked ? 'revoked' : 'active'} (+${mintRevoked ? 15 : 0}); freeze authority ${freezeRevoked ? 'revoked' : 'active'} (+${freezeRevoked ? 15 : 0}).`
  }
  components.push({ label: 'Authority Safety', points: authorityPoints, maxPoints: 30, reason: authorityReason })

  // ── Supply safety (0-15): permanently fixed supply ──────────────────────────────────────────
  const supplyPoints = supplyControl.supplyPermanentlyFixed === true ? 15 : 0
  components.push({ label: 'Supply Safety', points: supplyPoints, maxPoints: 15, reason: supplyControl.supplyFixedReason })

  // ── Cluster / funding confidence (0-15) ──────────────────────────────────────────────────────
  let clusterPoints = 0
  let clusterReason: string
  const clusterSkipped = !clusterMap || !clusterMap.attempted
  if (clusterSkipped) {
    clusterReason = 'Deep Cluster Check has not been run for this mint — funding-path evidence is unavailable. Not counted against this score (see scaledMaxScore).'
  } else if (clusterMap.evidenceCount === 0) {
    clusterReason = 'Deep Cluster Check ran but found no verified wallet relationships.'
  } else {
    const confidencePoints = clusterMap.clusterConfidence === 'medium' ? 10 : clusterMap.clusterConfidence === 'low' ? 5 : 0
    const riskPenalty = clusterMap.riskLevel === 'elevated' ? 5 : 0
    clusterPoints = Math.max(0, confidencePoints - riskPenalty + (clusterMap.riskLevel === 'standard' ? 5 : 0))
    clusterReason = `${clusterMap.summary} Risk read: ${clusterMap.riskLevel === 'unknown' ? 'unknown' : clusterMap.riskReason}`
  }
  components.push({ label: 'Cluster / Funding Confidence', points: clusterPoints, maxPoints: 15, reason: clusterReason, skipped: clusterSkipped })

  // ── Pattern safety (0-10): any HIGH/MEDIUM-confidence pattern actually detected as risky ──────
  const riskyPattern = patterns.patterns.find((p) => p.detected === true && (p.key === 'holder_concentration'))
  const patternPoints = riskyPattern ? 5 : 10
  const patternReason = riskyPattern
    ? `${riskyPattern.label}: ${riskyPattern.evidence}`
    : 'No risky pattern detected among the patterns this engine can verify from available evidence (see Pattern Analysis for what could not be checked).'
  components.push({ label: 'Pattern Safety', points: patternPoints, maxPoints: 10, reason: patternReason })

  const score = components.reduce((s, c) => s + c.points, 0)
  const maxScore = components.reduce((s, c) => s + c.maxPoints, 0)
  const scaledMaxScore = components.reduce((s, c) => s + (c.skipped ? 0 : c.maxPoints), 0)
  return { score, maxScore, scaledMaxScore, components }
}
