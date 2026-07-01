// MODULE 7 — behaviorIntel: pure helper functions.

import type { ChainSelectionResult } from '../chainSelection/types'
import type { SupportedChain } from '../providerFetchWindow/types'
import type { HoldingForConcentration } from './types'

// PURE. Basic uniform-spacing / clustering detection over a sorted list of millisecond
// timestamps. Never claims certainty — this is a coarse statistical signal, not a proof.
export function detectUniformSpacing(timestampsMs: number[]): { uniform: boolean; subSecondClusters: number } {
  if (timestampsMs.length < 3) return { uniform: false, subSecondClusters: 0 }
  const sorted = [...timestampsMs].sort((a, b) => a - b)
  const gaps: number[] = []
  let subSecondClusters = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    gaps.push(gap)
    if (gap < 1000) subSecondClusters += 1
  }
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length
  if (mean === 0) return { uniform: true, subSecondClusters }
  const variance = gaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / gaps.length
  const stdDev = Math.sqrt(variance)
  const coefficientOfVariation = stdDev / mean
  // A low coefficient of variation means gaps are suspiciously consistent — natural human trading
  // activity is rarely this regular.
  const uniform = coefficientOfVariation < 0.15 && gaps.length >= 4
  return { uniform, subSecondClusters }
}

export function activeChainsFrom(chainSelection: ChainSelectionResult): SupportedChain[] {
  return chainSelection.chains.filter((c) => c.status === 'active_intelligence').map((c) => c.chain)
}

export function primaryChainFrom(chainSelection: ChainSelectionResult): SupportedChain | null {
  const active = chainSelection.chains.filter((c) => c.status === 'active_intelligence')
  if (active.length === 0) return null
  return active.reduce((best, c) => (c.visible_value_usd > best.visible_value_usd ? c : best)).chain
}

export function concentrationLabelFor(topHoldingPercent: number): 'high' | 'medium' | 'balanced' {
  if (topHoldingPercent >= 50) return 'high'
  if (topHoldingPercent >= 25) return 'medium'
  return 'balanced'
}

export function topHolding(holdings: HoldingForConcentration[]): { symbol: string; percent: number } | null {
  if (holdings.length === 0) return null
  const totalValue = holdings.reduce((sum, h) => sum + h.valueUsd, 0)
  if (totalValue <= 0) return null
  const top = [...holdings].sort((a, b) => b.valueUsd - a.valueUsd)[0]
  return { symbol: top.symbol, percent: (top.valueUsd / totalValue) * 100 }
}
