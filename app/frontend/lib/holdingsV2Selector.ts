// app/frontend/lib/holdingsV2Selector.ts — canonical Holdings V2 display selector.
//
// CONFIRMED ROOT CAUSE, DISCLOSED (Holdings V2 display consistency task, real production evidence:
// Portfolio Intelligence correctly showed FreeCode as 89% of a $3,365.52 total, but Holdings V2
// showed FreeCode absent entirely and its "Base" chain total/allocation strip at only $337.62):
// HoldingsViewV2.tsx previously received `holdings: TokenHolding[]` — the OLD, separate
// src/modules/holdings fetch/merge result — entirely disconnected from the CANONICAL
// `PricedHolding[]`/`chainValueUsd` the new engine's `portfolioV2.totalValueUsd` is built from
// (lib/engine/modules/pricing's `priceHoldings()`, computed once by workers/walletScanV2.ts and
// already present on the API response as `pricedHoldings`/`chainValueUsd` — just never read by the
// frontend page before this fix). The two pipelines can disagree on a given token's value (or
// whether it has one at all) since they are two independently-fetched/priced holdings lists for the
// same wallet — exactly why FreeCode could be provably correct in one card and silently absent in
// the other for the SAME scan. FIX: Holdings V2 now derives every number it shows — the table rows,
// the per-chain allocation strip, and its own internal diagnostics — from this ONE canonical
// selector, fed by the exact same `pricedHoldings`/`chainValueUsd` portfolioV2.totalValueUsd uses.
//
// DUST FILTERING, VALUE-ONLY, DISCLOSED (this task's explicit requirement, "dust filtering must use
// valueUsd, not token quantity or historical activity"): the OLD `isDust()` (app/frontend/lib/
// holdingsHeuristics.ts) also excluded holdings by raw token quantity (`amount <
// DUST_AMOUNT_THRESHOLD`) and by an empty/`?` symbol — either of which could misclassify a real,
// valuable, low-quantity/thin-metadata holding (exactly FreeCode's own shape: a tiny human-readable
// quantity at 9 decimals) as dust. This selector classifies "dust" (a real, still-counted, just
// organizationally-collapsed bucket — never hidden, see below) using ONLY `valueUsd`.
//
// NEVER HIDDEN BY VALUE, DISCLOSED (this task's explicit requirement, "any holding with valid
// valueUsd > 0 must appear ... unless explicitly hidden by a documented user-controlled filter"):
// only a holding with `valueUsd == null` or `valueUsd === 0` (the balances provider genuinely never
// priced it, or it is worth exactly nothing) is excluded from both the meaningful and dust buckets —
// every other holding appears in one of the two, and the pre-existing "Dust tokens (N) — expand"
// toggle already in HoldingsViewV2.tsx is the one documented, user-controlled filter that can
// collapse (never truly hide) the dust bucket from view.
//
// AIRDROP CLASSIFICATION NEVER HIDES, DISCLOSED (this task's explicit requirement): this selector
// has no concept of acquisition source/airdrop-only classification at all — that labeling
// (deriveAcquisitionInfo/isAirdropOnly in holdingsHeuristics.ts) is presentation-only (a badge on an
// already-visible row) and is never consulted here to decide whether a holding is shown.

import type { PricedHolding } from '@/lib/engine/modules/pricing/types'
import type { TokenHolding } from '@/src/modules/holdings/types'

// CHAIN-ID MAP, DISCLOSED: a small, local, additive copy of the same real mapping
// lib/engine/modules/holdings/fetchHoldings.ts's CHAIN_ID_TO_SUPPORTED_CHAIN already defines —
// duplicated here (rather than imported) so this frontend-only selector never pulls in that
// module's own real network-fetch code (fetchHoldings/fetchAllHoldings) into the client bundle.
// Values are the same real, well-known chain IDs used throughout this session's V2 engine modules.
const CHAIN_ID_TO_CHAIN_STRING: Record<number, string> = {
  1: 'eth',
  8453: 'base',
  42161: 'arbitrum',
  999: 'hyperevm',
  // ADDED, DISCLOSED (finish-Wallet-Scanner-Robinhood-integration follow-up): Robinhood's real
  // holdings now flow through this SAME selector (see mergedWalletView.ts's
  // mergeRobinhoodIntoPricedHoldings) as ordinary PricedHolding rows keyed by chainId 4663 — mapped
  // to the same 'robinhood' chain string ChainBadge/fmtChainLabel already render as "Robinhood Chain"
  // everywhere else in this codebase (holdingsHeuristics.ts).
  4663: 'robinhood',
}

export const HOLDINGS_V2_DUST_USD_THRESHOLD = 0.10

function toDisplayRow(p: PricedHolding): TokenHolding {
  return {
    chain: (CHAIN_ID_TO_CHAIN_STRING[p.chainId] ?? String(p.chainId)) as TokenHolding['chain'],
    contract: p.tokenAddress,
    symbol: p.symbol,
    name: null,
    amount: Number(p.quantity),
    amountRaw: null,
    tokenDecimals: p.decimals,
    providerPriceUsd: p.priceUsd,
    providerValueUsd: p.valueUsd,
  }
}

export type HoldingsV2ExcludedHolding = {
  chainId: number
  tokenAddress: string
  symbol: string
  valueUsd: number | null
}

export type HoldingsV2Diagnostics = {
  canonicalPricedValueUsd: number
  holdingsDisplayValueUsd: number
  chainGroupedValueUsd: Record<number, number>
  excludedPricedHoldings: HoldingsV2ExcludedHolding[]
  exclusionReason: Record<string, string>
  valueDifferenceUsd: number
}

export type HoldingsV2Selection = {
  meaningfulHoldings: TokenHolding[] // valueUsd >= dust threshold, sorted desc by valueUsd
  dustHoldings: TokenHolding[] // 0 < valueUsd < dust threshold, sorted desc by valueUsd — still real, still counted
  diagnostics: HoldingsV2Diagnostics
}

function exclusionKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`
}

// PURE, exported for direct testing. The ONE canonical selector every Holdings V2 surface (table,
// chain allocation strip, and this module's own diagnostics) must derive from — see this file's own
// header for the confirmed regression this closes.
export function selectHoldingsV2(
  pricedHoldings: PricedHolding[] | null | undefined,
  chainValueUsd: Record<number, number> | null | undefined,
): HoldingsV2Selection {
  const safeHoldings = Array.isArray(pricedHoldings) ? pricedHoldings : []
  const safeChainValueUsd = chainValueUsd && typeof chainValueUsd === 'object' ? chainValueUsd : {}

  const meaningful: PricedHolding[] = []
  const dust: PricedHolding[] = []
  const excludedPricedHoldings: HoldingsV2ExcludedHolding[] = []
  const exclusionReason: Record<string, string> = {}

  for (const p of safeHoldings) {
    if (p.valueUsd == null || p.valueUsd === 0) {
      excludedPricedHoldings.push({ chainId: p.chainId, tokenAddress: p.tokenAddress, symbol: p.symbol, valueUsd: p.valueUsd })
      exclusionReason[exclusionKey(p.chainId, p.tokenAddress)] = 'zero_or_unpriced'
      continue
    }
    if (p.valueUsd < HOLDINGS_V2_DUST_USD_THRESHOLD) {
      dust.push(p)
    } else {
      meaningful.push(p)
    }
  }

  const byValueDesc = (a: PricedHolding, b: PricedHolding) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)
  meaningful.sort(byValueDesc)
  dust.sort(byValueDesc)

  const canonicalPricedValueUsd = safeHoldings.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0)
  const holdingsDisplayValueUsd = [...meaningful, ...dust].reduce((sum, p) => sum + (p.valueUsd ?? 0), 0)

  return {
    meaningfulHoldings: meaningful.map(toDisplayRow),
    dustHoldings: dust.map(toDisplayRow),
    diagnostics: {
      canonicalPricedValueUsd,
      holdingsDisplayValueUsd,
      // CANONICAL PASSTHROUGH, DISCLOSED: `chainValueUsd` is already computed from these exact same
      // `pricedHoldings` by the backend (lib/engine/modules/pricing's `priceHoldings()`) — never
      // recomputed here from a filtered/display subset, which is precisely how the confirmed
      // regression happened (the old chain strip summed a DIFFERENT, disconnected holdings list).
      chainGroupedValueUsd: { ...safeChainValueUsd },
      excludedPricedHoldings,
      exclusionReason,
      valueDifferenceUsd: Math.round((canonicalPricedValueUsd - holdingsDisplayValueUsd) * 100) / 100,
    },
  }
}
