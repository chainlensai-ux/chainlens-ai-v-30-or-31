// lib/server/baseRadarHolderConcentration.ts — single reusable entry point for Base Radar holder
// count + concentration resolution, composing the already-proven GoldRush/Covalent helpers in
// lib/server/goldrushHolderCount.ts with the evidence-shape builder in lib/baseRadarHolderEvidence.ts.
//
// PROVIDER-ORDER, DISCLOSED (explicitly directed: "Use GoldRush/Covalent token holders data first...
// Alchemy should only be used if there is an existing ERC20 holder/top-holder path already in the
// codebase... Do NOT use Alchemy NFT owner endpoints for ERC20 holders... Do NOT add Moralis"):
//   1. GoldRush/Covalent token_holders_v2 (fetchGoldRushHolderCount for count, fetchGoldRushConcentration
//      for top1/10/20 — both already used elsewhere in this codebase, not new dependencies).
//   2. An existing Alchemy ERC20 top-holder path — searched for and confirmed NOT to exist anywhere in
//      this codebase (Alchemy is used here only for RPC eth_call reads and NFT-unrelated asset
//      transfers, never a holder-list/top-holder endpoint), so this step is genuinely skipped rather
//      than stubbed — never NFT getOwnersForContract/getOwnersForToken, which return the wrong kind of
//      data for an ERC20 concentration question entirely.
//   3. The existing minimum-count fallback ("100+", already handled inside fetchGoldRushHolderCount's
//      isCapped signal / lib/baseRadarHolderEvidence.ts's countIsMinimum handling).
//   4. Unavailable — honest N/A, never inferred from the minimum count.
import { fetchGoldRushHolderCount, fetchGoldRushConcentration } from './goldrushHolderCount.ts'
import { buildBaseRadarHolderEvidence, type HolderEvidence } from '../baseRadarHolderEvidence.ts'

export interface ResolveBaseRadarHolderConcentrationInput {
  chain: 'base' | 'robinhood'
  tokenAddress: string
  // Accepted for interface completeness / for a caller that already resolved these elsewhere — NOT
  // required and not used to normalize balances here. fetchGoldRushConcentration computes every
  // percentage as balance/totalSupply using two raw values read from the SAME provider response (or,
  // when that response omits totalSupply, a single same-unit on-chain totalSupply() read — see that
  // function's own RATIO-CANCELS-DECIMALS comment) — decimals cancel out of the ratio, so an
  // externally supplied totalSupply/decimals would never change the computed percentages and is never
  // required. Present purely so a caller that already has these on hand can pass them through without
  // a type mismatch.
  totalSupply?: bigint | string | number | null
  decimals?: number | null
  // Skip the count-only provider call when the caller already has a resolved holder count from
  // elsewhere this same request cycle (e.g. a scan that already ran) — avoids a redundant call.
  knownHolderCount?: { count: number; isMinimum: boolean } | null
}

export interface ResolvedBaseRadarHolderConcentration extends HolderEvidence {
  holderProvider: 'goldrush' | null
  // Real, measured — surfaced so aggregate audit objects can report cache-hit counts without
  // guessing (see fetchGoldRushConcentration's own fromCache field).
  concentrationFromCache: boolean
  concentrationReason: string
}

export async function resolveBaseRadarHolderConcentration(
  input: ResolveBaseRadarHolderConcentrationInput,
): Promise<ResolvedBaseRadarHolderConcentration> {
  const { chain, tokenAddress } = input
  let holderCount: number | null = null
  let countIsMinimum = false
  let holderProviderReachable = true
  let holderProvider: 'goldrush' | null = null

  if (input.knownHolderCount) {
    holderCount = input.knownHolderCount.count
    countIsMinimum = input.knownHolderCount.isMinimum
    holderProvider = 'goldrush'
  } else {
    const countResult = await fetchGoldRushHolderCount(tokenAddress, chain)
    holderCount = countResult.count
    countIsMinimum = countResult.isCapped === true
    holderProviderReachable = !['timeout', 'http_error', 'no_api_key', 'rate_limited'].includes(countResult.reason)
    if (countResult.count != null) holderProvider = 'goldrush'
  }

  const concentration = await fetchGoldRushConcentration(tokenAddress, chain)
  const concentrationProvider: 'goldrush' | null = concentration.reason === 'ok' ? 'goldrush' : null
  if (concentrationProvider) holderProvider = holderProvider ?? 'goldrush'

  const evidence = buildBaseRadarHolderEvidence({
    holderCount,
    countIsMinimum,
    top1Percent: concentration.top1,
    top10Percent: concentration.top10,
    top20Percent: concentration.top20,
    holderProviderReachable,
    concentrationProvider,
  })

  return { ...evidence, holderProvider, concentrationFromCache: concentration.fromCache === true, concentrationReason: concentration.reason }
}
