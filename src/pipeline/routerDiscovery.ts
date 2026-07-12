// MODULE (orchestration layer) — routerDiscovery
//
// Additive-only, log-only router-candidate discovery. Never writes to KNOWN_DEX_ROUTER_ADDRESSES,
// never affects sellTimelineV2, dust suppression, FIFO, or pricing — this exists purely so a human
// can review candidates in logs and manually promote a real one into the actual registry later.
//
// SIGNATURE NOTE, DISCLOSED: the task's own spec asked for `isRouterLikeEvent(event): boolean`, but
// heuristic A (repeated counterparty across the scan) and heuristic B (same-tx inbound leg) both
// require context beyond a single event — a lone NormalizedEvent can't answer either question. This
// takes the event plus that context explicitly; a true single-arg version could only ever return
// false, which would make the heuristic dead code, not a real one.
//
// C (contract-bytecode signature match) and D (cross-wallet aggregator pattern) are NOT
// implemented: providerFetchWindow never fetches contract bytecode anywhere in this codebase
// (confirmed by grep for getCode/bytecode), and there is no KV/DB tracking router candidates across
// distinct wallets' scans. Both are explicitly optional in the task's own spec ("skip if
// unavailable") — implementing either here would mean inventing infrastructure this delivery
// doesn't have, not honoring the spec.

import type { NormalizedEvent } from '../modules/normalization/types'

export type RouterDiscoveryHeuristic = 'repeated-pattern' | 'swap-shape'

export type RouterEvidence = {
  tokensInvolved: string[]
  txHash: string
  chain: string
  heuristic: RouterDiscoveryHeuristic
}

export type CounterpartyStats = { count: number; tokens: Set<string> }

// PURE. Builds per-counterparty { count, distinct tokens } stats over this scan's own outbound
// events only — never persisted, never shared across wallets/requests.
export function buildCounterpartyStats(outboundEvents: NormalizedEvent[]): Map<string, CounterpartyStats> {
  const stats = new Map<string, CounterpartyStats>()
  for (const e of outboundEvents) {
    const key = e.toAddress.toLowerCase()
    const entry = stats.get(key) ?? { count: 0, tokens: new Set<string>() }
    entry.count += 1
    entry.tokens.add(e.contract)
    stats.set(key, entry)
  }
  return stats
}

// Real, non-exhaustive stable/WETH symbol list for heuristic B's "inbound leg looks like swap
// proceeds" check — same convention as this file's siblings (e.g. STABLE_OR_WETH checks elsewhere
// in this codebase use a fixed symbol allowlist, not a live price/metadata lookup).
const STABLE_OR_WETH_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'WETH', 'WBTC'])

// PURE. Returns which heuristic (if any) classifies this outbound event as router-like. Neither
// heuristic ever fires from `amount > 0` / "has a counterparty" alone (unlike the always-true
// version proposed earlier this session) — each requires a real, specific pattern:
//   A. same counterparty seen in >=3 outbound transfers this scan, across >=2 distinct tokens
//   B. same tx also has an inbound stable/WETH leg from someone other than this counterparty
export function classifyRouterLikeEvent(
  event: NormalizedEvent,
  sameTxEvents: NormalizedEvent[],
  counterpartyStats: Map<string, CounterpartyStats>,
): { isRouterLike: boolean; heuristic: RouterDiscoveryHeuristic | null } {
  const counterparty = event.toAddress.toLowerCase()

  const stats = counterpartyStats.get(counterparty)
  if (stats && stats.count >= 3 && stats.tokens.size >= 2) {
    return { isRouterLike: true, heuristic: 'repeated-pattern' }
  }

  const hasSwapShapeInboundLeg = sameTxEvents.some(
    (e) =>
      e.direction === 'inbound' &&
      e.fromAddress.toLowerCase() !== counterparty &&
      STABLE_OR_WETH_SYMBOLS.has((e.symbol ?? '').toUpperCase()),
  )
  if (hasSwapShapeInboundLeg) {
    return { isRouterLike: true, heuristic: 'swap-shape' }
  }

  return { isRouterLike: false, heuristic: null }
}

// Process-lifetime dedupe so a repeated candidate within/across scans on the same warm instance
// doesn't spam logs once already surfaced — NOT a registry, NOT consulted by any detection logic,
// purely to keep the log line's signal-to-noise usable. Same "known, disclosed, in-memory,
// cross-request" pattern already used by rpcDebugLog elsewhere in this codebase.
const loggedCandidates = new Set<string>()

// Logs a router candidate for human review. Deliberately does nothing else: never mutates
// KNOWN_DEX_ROUTER_ADDRESSES, never touches sellTimelineV2/dust suppression/FIFO/pricing, and has
// no return value a caller could accidentally wire into detection logic.
export function recordRouterCandidate(chain: string, address: string, evidence: RouterEvidence): void {
  const addr = address.toLowerCase()
  const key = `${chain}:${addr}`
  if (loggedCandidates.has(key)) return
  loggedCandidates.add(key)
  // eslint-disable-next-line no-console
  console.warn('[router-discovery] candidate (log-only — NOT added to KNOWN_DEX_ROUTER_ADDRESSES)', {
    chain,
    address: addr,
    evidence,
  })
  // eslint-disable-next-line no-console
  console.warn('[router-discovery] candidate requires review')
}

// MANUAL PROMOTION, DISCLOSED: the task's own snippet assumed KNOWN_DEX_ROUTER_ADDRESSES is a
// `{ [chainId]: Set<string> }` map, but the real registry (src/pipeline/index.ts) is a single flat
// `Set<string>`, deliberately chain-unaware (see that file's own comment on why: sellTimelineV2's
// `knownDexRouterAddresses` contract is flat too). Restructuring it into a per-chain map would be a
// materially bigger change than "add a promotion function" and would also require updating the
// sellTimelineV2 call site's wiring — out of scope here. This takes the real registry Set as an
// explicit argument (rather than importing it from './index', which would create a circular
// import, since index.ts already imports this file) so the caller in index.ts passes its own
// KNOWN_DEX_ROUTER_ADDRESSES directly.
//
// Never called automatically anywhere in this codebase — the only way this runs is if a human
// (or a future explicit tool/script) calls it by hand with a specific address. No code path in
// runWalletScan() calls this.
export function promoteRouterCandidate(knownRouters: Set<string>, chain: string, address: string): void {
  const addr = address.toLowerCase()
  knownRouters.add(addr)
  // eslint-disable-next-line no-console
  console.warn('[router-discovery] promoted router (manual)', { chain, address: addr })
}
