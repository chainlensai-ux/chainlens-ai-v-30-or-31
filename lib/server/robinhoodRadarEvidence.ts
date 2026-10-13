// Robinhood Radar evidence: the two checks that left every Robinhood card "Unverified".
//
// 1. Holder count. The feed only asked GoldRush, whose Robinhood coverage is thin (and whose count is
//    page-capped at 100). A failed lookup set holderVerified=false, which caps a card at UNVERIFIED on
//    every branch. Robinhood now reads the chain explorer's own indexer (Blockscout holders_count) first
//    and falls back to GoldRush only when Blockscout gives no answer.
// 2. Sell check. honeypot.is has no Robinhood support, so the feed never ran any buy/sell check for
//    Robinhood. It now runs the same ChainLens Robinhood simulation the Token Scanner uses (V2/V3 WETH
//    venues, eth_call only). Uniswap V4 pools stay an honest "unsupported pool model" open check.

import { fetchGoldRushHolderCount, type HolderCountResult } from './goldrushHolderCount'
import { getBlockscoutTokenInfo, type FetchImpl } from './robinhoodBlockscoutEvidence'
import { simulateRobinhoodHoneypot, ROBINHOOD_HONEYPOT_CHAIN_ID, type RobinhoodHoneypotSimResult } from './robinhoodHoneypotSimulation'
import type { RadarSimulationOpenCheckReason } from '../baseRadarSimulation'

export type RadarHoneypotResult = {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  simulationSuccess: boolean | null
  failureReason?: RadarSimulationOpenCheckReason
}

/** PURE. Blockscout's holders_count (newer instances: holders) as a non-negative integer, else null. */
export function parseBlockscoutHolderCount(info: { holders_count?: unknown; holders?: unknown } | null | undefined): number | null {
  const raw = info?.holders_count ?? info?.holders
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

type HolderDeps = {
  blockscout?: (address: string) => Promise<{ data: { holders_count?: unknown; holders?: unknown } | null }>
  goldrush?: (contract: string, chain: 'base' | 'robinhood') => Promise<HolderCountResult>
}

/** Radar holder count. Base: GoldRush (unchanged). Robinhood: Blockscout first, GoldRush fallback. */
export async function fetchRadarHolderCount(contract: string, chain: 'base' | 'robinhood', deps: HolderDeps = {}): Promise<HolderCountResult> {
  const goldrush = deps.goldrush ?? fetchGoldRushHolderCount
  if (chain !== 'robinhood') return goldrush(contract, chain)
  const blockscout = deps.blockscout ?? ((address: string) => getBlockscoutTokenInfo(address, fetch as unknown as FetchImpl))
  const info = await blockscout(contract.toLowerCase()).catch(() => null)
  const count = parseBlockscoutHolderCount(info?.data)
  if (count != null) return { count, reason: 'ok', chainPathUsed: 'blockscout', isCapped: false }
  return goldrush(contract, chain)
}

/** PURE. GeckoTerminal dex id → the pool-type hint the Robinhood simulator understands. */
export function robinhoodPoolTypeFromDexId(dexId: string | null | undefined): string | null {
  const d = String(dexId ?? '').toLowerCase()
  if (d.includes('v4')) return 'v4'
  if (d.includes('v3') || d.includes('slipstream')) return 'v3'
  if (d.includes('v2')) return 'v2'
  return null
}

/** PURE. Robinhood simulation result → the radar's honeypot shape (same semantics as a honeypot.is answer). */
export function robinhoodSimToRadarHoneypot(sim: Pick<RobinhoodHoneypotSimResult, 'honeypotStatus' | 'buyTaxPct' | 'sellTaxPct'>): RadarHoneypotResult {
  switch (sim.honeypotStatus) {
    case 'sellable':
      return { isHoneypot: false, buyTax: sim.buyTaxPct, sellTax: sim.sellTaxPct, simulationSuccess: true }
    case 'blocked':
      return { isHoneypot: true, buyTax: sim.buyTaxPct, sellTax: sim.sellTaxPct, simulationSuccess: true }
    case 'unsupported':
      return { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: 'unsupported_pool_model' }
    case 'timeout':
      return { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: 'timeout_after_retry' }
    default:
      return { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: 'provider_unavailable' }
  }
}

/** Radar sell check for one Robinhood pool. Never throws. */
export async function robinhoodRadarHoneypot(
  input: { contract: string; poolAddress: string | null; dexId: string | null },
  simulate: typeof simulateRobinhoodHoneypot = simulateRobinhoodHoneypot,
): Promise<RadarHoneypotResult> {
  const poolType = robinhoodPoolTypeFromDexId(input.dexId)
  if (poolType === 'v4') return robinhoodSimToRadarHoneypot({ honeypotStatus: 'unsupported', buyTaxPct: null, sellTaxPct: null })
  try {
    const { result } = await simulate({ chainId: ROBINHOOD_HONEYPOT_CHAIN_ID, tokenAddress: input.contract, poolAddress: input.poolAddress, poolType })
    return robinhoodSimToRadarHoneypot(result)
  } catch {
    return robinhoodSimToRadarHoneypot({ honeypotStatus: 'unavailable', buyTaxPct: null, sellTaxPct: null })
  }
}
