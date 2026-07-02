// Shared, pure helpers for holdings UI (HoldingsViewV2 + anything else that groups/filters real
// TokenHolding data). Factored out so the dust/personality/acquisition logic has one home instead
// of being copy-pasted across components.
//
// HONESTY NOTE: every function here reads only real fields (TokenHolding.contract/chain/amount/
// providerValueUsd, BuyTimelineEntry.chain/token/timestamp/sourceType, BridgeCandidateEvent.
// chainTo/token) and never invents a value for a field that isn't present. See each function's
// comment for what it deliberately does NOT attempt to derive.

import type { TokenHolding } from '@/src/modules/holdings/types'
import type { BuyTimelineEntry } from '@/src/modules/timelineBuilder/types'
import type { BridgeCandidateEvent } from '@/src/modules/bridgeDetection/types'

export const DUST_AMOUNT_THRESHOLD = 0.001
export const DUST_USD_THRESHOLD = 0.10
export const TOP_HOLDING_USD_THRESHOLD = 5

export const CHAIN_LABELS: Record<string, string> = {
  base: 'Base',
  eth: 'ETH',
  arbitrum: 'Arbitrum',
  hyperevm: 'HyperEVM · pending', // no verified provider yet — see providerFetchWindow's HyperEVM TODO
}

export function fmtChainLabel(chain: string): string {
  return CHAIN_LABELS[chain] ?? chain
}

export function fmtUsd(value: number | null | undefined): string {
  return value == null ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtSignedUsd(value: number | null | undefined): string {
  if (value == null) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtAmount(amount: number): string {
  if (amount >= 1000) return amount.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return amount.toFixed(amount < 1 ? 6 : 4).replace(/0+$/, '').replace(/\.$/, '')
}

export function fmtDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'Not available'
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function holdingKey(h: TokenHolding): string {
  return `${h.chain}:${h.contract.toLowerCase()}`
}

// A holding with a real, known USD value of exactly $0, or no priced value at all
// (providerValueUsd null — the balances provider never returned a price for it). Distinct from
// isDust below: isDust still includes small-but-priced or unpriced-but-tiny-amount tokens for the
// collapsible dust bucket, whereas this is used to hide zero/unpriced noise entirely (per explicit
// request) rather than just collapse it.
export function hasNoUsdValue(holding: TokenHolding): boolean {
  return holding.providerValueUsd == null || holding.providerValueUsd === 0
}

export function isDust(holding: TokenHolding): boolean {
  if (holding.amount < DUST_AMOUNT_THRESHOLD) return true
  if (holding.providerValueUsd !== null && holding.providerValueUsd < DUST_USD_THRESHOLD) return true
  if (!holding.symbol || holding.symbol.trim() === '' || holding.symbol === '?') return true
  return false
}

export function groupHoldingsByChain(holdings: TokenHolding[]): Map<string, TokenHolding[]> {
  const map = new Map<string, TokenHolding[]>()
  for (const h of holdings) {
    const group = map.get(h.chain) ?? []
    group.push(h)
    map.set(h.chain, group)
  }
  return map
}

export type AcquisitionInfo = {
  firstSeenMs: number | null
  lastSeenMs: number | null
  badges: string[]
}

// PURE. Derives real acquisition context for one holding by matching it against real
// buyTimeline/bridgeTimeline entries — never invents a date or a source when no matching entry
// exists.
export function deriveAcquisitionInfo(
  holding: TokenHolding,
  buyEntries: BuyTimelineEntry[],
  bridgeEntries: BridgeCandidateEvent[],
): AcquisitionInfo {
  const matchingBuys = buyEntries.filter(
    (e) => e.chain === holding.chain && e.token.toLowerCase() === holding.contract.toLowerCase(),
  )
  const matchingBridgeIn = bridgeEntries.filter(
    (b) => b.chainTo === holding.chain && b.token.toLowerCase() === holding.symbol.toLowerCase(),
  )

  const timestamps = matchingBuys.map((e) => e.timestamp)
  const firstSeenMs = timestamps.length > 0 ? Math.min(...timestamps) : null
  const lastSeenMs = timestamps.length > 0 ? Math.max(...timestamps) : null

  const badges: string[] = []
  if (matchingBuys.length > 0 && matchingBuys.every((e) => e.sourceType === 'airdrop')) {
    badges.push('Airdrop-only')
  } else if (matchingBuys.some((e) => e.sourceType === 'swap')) {
    badges.push('Swap-acquired')
  }
  if (matchingBridgeIn.length > 0) badges.push('Bridge-acquired')

  return { firstSeenMs, lastSeenMs, badges }
}

export function isAirdropOnly(holding: TokenHolding, buyEntries: BuyTimelineEntry[]): boolean {
  const matches = buyEntries.filter((e) => e.chain === holding.chain && e.token.toLowerCase() === holding.contract.toLowerCase())
  return matches.length > 0 && matches.every((e) => e.sourceType === 'airdrop')
}

export function daysHeld(firstSeenMs: number | null): string {
  if (firstSeenMs == null) return 'Not available'
  const days = Math.max(0, Math.floor((Date.now() - firstSeenMs) / (24 * 60 * 60 * 1000)))
  return `${days} day(s)`
}

// PURE. Holdings Personality — derived ONLY from real counts/values (dust/meaningful counts,
// distinct-chain count, providerValueUsd distribution, and — only when real buyEntries evidence
// exists — the airdrop-only acquisition share). Returns null (no card rendered) rather than
// forcing one of the five labels when no threshold is actually met by the real data.
export function derivePersonality(holdings: TokenHolding[], buyEntries: BuyTimelineEntry[]): string | null {
  const total = holdings.length
  if (total === 0) return null

  const meaningful = holdings.filter((h) => !isDust(h))
  const dustCount = total - meaningful.length
  const meaningfulCount = meaningful.length

  if (meaningfulCount === 0) return 'Mostly dust'
  if (dustCount / total >= 0.85 && meaningfulCount <= 2) return 'Mostly dust'

  if (buyEntries.length > 0) {
    const airdropOnlyCount = meaningful.filter((h) => isAirdropOnly(h, buyEntries)).length
    if (airdropOnlyCount / meaningfulCount >= 0.5) return 'Airdrop-heavy'
  }

  if (meaningfulCount <= 2) return 'Few meaningful positions'

  const priced = meaningful.filter((h) => h.providerValueUsd != null)
  const totalValue = priced.reduce((sum, h) => sum + h.providerValueUsd!, 0)
  const distinctChains = new Set(meaningful.map((h) => h.chain))

  if (distinctChains.size >= 3 && totalValue > 0) {
    const byChain = new Map<string, number>()
    for (const h of priced) byChain.set(h.chain, (byChain.get(h.chain) ?? 0) + h.providerValueUsd!)
    const maxChainValue = Math.max(0, ...byChain.values())
    if (maxChainValue / totalValue < 0.6) return 'High scatter'
  }

  if (totalValue > 0) {
    const topValue = Math.max(0, ...priced.map((h) => h.providerValueUsd!))
    // Holdings-value-distribution signal, distinct from behaviorIntel.convictionScore (which is
    // trade-frequency-based) — same label, different real evidence.
    if (topValue / totalValue < 0.3) return 'Low conviction'
  }

  return null
}
