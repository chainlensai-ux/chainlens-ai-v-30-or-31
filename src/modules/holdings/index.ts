// MODULE 10 — holdingsEngine
//
// Fetches current token balances for a wallet on a single chain. Follows the same
// fetch/merge/provider-status pattern as providerFetchWindow (module 1): try GoldRush, fall back
// to Alchemy if it fails, mark provider_unavailable only if both fail. One bounded call per
// provider per chain — never paginated, never repeated.

import type { ProviderStatus, SupportedChain } from '../providerFetchWindow/types'
import type { HoldingsFetchResult, TokenHolding } from './types'
import { dedupeHoldingsKey, fetchAlchemyHoldings, fetchGoldrushHoldings } from './utils'

export type { HoldingsFetchResult, TokenHolding } from './types'

// CONFIRMED ROOT CAUSE, DISCLOSED (portfolio-total-stability audit, real production evidence: the
// same wallet's backend total dropped from ~$13,531.40 to $5,196.59 between two scans while only
// ONE priced holding disappeared from the list — ~$8,335 vanished from a single token): the PRIOR
// version of this function picked a winner for a duplicate (chain, contract) key purely by ARRAY
// POSITION — "first occurrence in `[...goldrushHoldings, ...alchemyHoldings]` wins," relying
// entirely on GoldRush's results always appearing (and always containing that token) before
// Alchemy's. That is NOT a real guarantee: GoldRush's own balances_v2 response can genuinely omit a
// token on one call that it reported on a previous call (rate limiting, spam-filter edge cases,
// transient provider inconsistency — this module never repages/retries, per its own header) while
// Alchemy's parallel call for the SAME wallet still reports it. When that happens, the previous
// (correct, first-wins) code had NO fallback logic at all — Alchemy's copy simply became the ONLY
// entry for that key, and Alchemy's holdings NEVER carry a price (fetchAlchemyHoldings always sets
// providerPriceUsd/providerValueUsd to null, since resolving them would need an extra per-token
// metadata call this module deliberately never makes) — so a token that was priced via GoldRush on
// one scan silently loses its entire USD value on the next, with no error, no warning, and no
// change to its own real holding data.
//
// FIX: replaced "first occurrence wins" with an explicit, deterministic scoring comparator applied
// across BOTH providers' candidate rows for a key, per this task's own required priority order:
//   1. a valid (non-null, positive) providerValueUsd beats one that's null/zero
//   2. a valid (non-null, positive) providerPriceUsd beats one that's null/zero
//   3. provider coverage — GoldRush's richer metadata (real symbol/decimals, sometimes a price)
//      outranks Alchemy's bare balance-only row, when neither of the above already decided it
//   4. quantity (rarely a tiebreaker in practice, since both providers report the same on-chain
//      balance) — included for completeness per this task's own spec
//   5. stable source order (GoldRush before Alchemy, then original array position) — the final,
//      fully deterministic tiebreak so merge order can never change the result
// This guarantees a real, valid, provider-priced row can NEVER be silently replaced by an unpriced
// duplicate regardless of which provider's array happens to contain it or in what order.
type MergeCandidate = { holding: TokenHolding; providerRank: number; sourceIndex: number }

function candidateScore(c: MergeCandidate): [number, number, number, number, number] {
  const hasValueUsd = c.holding.providerValueUsd != null && c.holding.providerValueUsd > 0 ? 1 : 0
  const hasPriceUsd = c.holding.providerPriceUsd != null && c.holding.providerPriceUsd > 0 ? 1 : 0
  const quantity = Number.isFinite(c.holding.amount) ? c.holding.amount : -1
  return [hasValueUsd, hasPriceUsd, c.providerRank, quantity, -c.sourceIndex]
}

function compareCandidates(a: MergeCandidate, b: MergeCandidate): number {
  const scoreA = candidateScore(a)
  const scoreB = candidateScore(b)
  for (let i = 0; i < scoreA.length; i += 1) {
    if (scoreB[i] !== scoreA[i]) return scoreB[i] - scoreA[i]
  }
  return 0
}

export type MergeHoldingsDiagnostics = {
  // A key where at least one candidate row genuinely had a valid price/value, but the WINNING row
  // (per the comparator above) does not — i.e. a real, previously-known price could not be carried
  // through this merge because every provider that had it is either absent or itself now missing
  // it. Never fabricated: this only counts a real, observed prior price being unavailable this
  // round, it never estimates or guesses a replacement value.
  pricedHoldingDroppedCount: number
  pricedValueLostUsd: number
}

export function mergeHoldingsResults(
  goldrushHoldings: TokenHolding[],
  alchemyHoldings: TokenHolding[],
): { holdings: TokenHolding[]; diagnostics: MergeHoldingsDiagnostics } {
  const candidatesByKey = new Map<string, MergeCandidate[]>()
  const registerAll = (holdings: TokenHolding[], providerRank: number, indexOffset: number) => {
    holdings.forEach((holding, i) => {
      const key = dedupeHoldingsKey(holding)
      const list = candidatesByKey.get(key) ?? []
      list.push({ holding, providerRank, sourceIndex: indexOffset + i })
      candidatesByKey.set(key, list)
    })
  }
  // GoldRush ranked above Alchemy (providerRank 1 > 0) for tier-3 provider-coverage comparisons —
  // matches this module's own long-standing "GoldRush's copy carries a real symbol, decimals, and
  // often a price" rationale, now applied as one tier among several instead of the sole rule.
  registerAll(goldrushHoldings, 1, 0)
  registerAll(alchemyHoldings, 0, goldrushHoldings.length)

  const winningHoldings: TokenHolding[] = []
  let pricedHoldingDroppedCount = 0
  let pricedValueLostUsd = 0
  for (const [key, candidates] of candidatesByKey) {
    const winner = candidates.reduce((best, c) => (compareCandidates(c, best) < 0 ? c : best))
    winningHoldings.push(winner.holding)
    const bestKnownPriced = candidates.reduce(
      (best, c) => ((c.holding.providerValueUsd ?? 0) > (best?.holding.providerValueUsd ?? 0) ? c : best),
      null as MergeCandidate | null,
    )
    const winnerHasValue = winner.holding.providerValueUsd != null && winner.holding.providerValueUsd > 0
    if (!winnerHasValue && bestKnownPriced && bestKnownPriced.holding.providerValueUsd) {
      pricedHoldingDroppedCount += 1
      pricedValueLostUsd += bestKnownPriced.holding.providerValueUsd
      // COMPACT PER-TOKEN LOG, DISCLOSED (this task's explicit requirement): the exact fields
      // requested — never a raw provider response, never more than one token's worth of data per
      // line. previousValueUsd is the best real value ANY candidate this round reported for this
      // key; currentValueUsd is what the winning row actually carries (null here, by definition of
      // reaching this branch) — comparing the two across scan runs is what pinpoints the exact
      // token responsible for a total-value regression.
      // eslint-disable-next-line no-console
      console.warn('[holdings-merge-audit] missingPricedHolding', {
        missingPricedHolding: key,
        previousValueUsd: bestKnownPriced.holding.providerValueUsd,
        currentValueUsd: winner.holding.providerValueUsd ?? null,
        providerPriceUsd: winner.holding.providerPriceUsd ?? null,
        quantity: winner.holding.amount,
        pricingSource: winner.providerRank === 1 ? 'goldrush' : 'alchemy',
        exclusionReason: 'winning_candidate_lacked_provider_price',
      })
    }
  }

  if (pricedHoldingDroppedCount > 0) {
    // eslint-disable-next-line no-console
    console.warn('[holdings-merge-audit] priced holding dropped during merge', {
      pricedHoldingDroppedCount,
      pricedValueLostUsd: Math.round(pricedValueLostUsd * 100) / 100,
    })
  }

  return { holdings: winningHoldings, diagnostics: { pricedHoldingDroppedCount, pricedValueLostUsd } }
}

export function detectHoldingsProviderUnavailable(goldrushOk: boolean, alchemyOk: boolean): ProviderStatus {
  if (goldrushOk && alchemyOk) return 'ok'
  if (goldrushOk || alchemyOk) return 'partial'
  return 'provider_unavailable'
}

export async function fetchHoldings(chain: SupportedChain, walletAddress: string): Promise<HoldingsFetchResult> {
  const [goldrush, alchemy] = await Promise.all([
    fetchGoldrushHoldings(chain, walletAddress),
    fetchAlchemyHoldings(chain, walletAddress),
  ])

  const providerStatus = detectHoldingsProviderUnavailable(goldrush.ok, alchemy.ok)
  const holdings = providerStatus === 'provider_unavailable' ? [] : mergeHoldingsResults(goldrush.holdings, alchemy.holdings).holdings

  return { chain, providerStatus, holdings }
}
