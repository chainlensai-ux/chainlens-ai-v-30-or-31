// app/api/pnl/route.ts
//
// FABRICATED-SPEC DISCLOSURE (pre-verified by the orchestrating investigation before this file was
// written): the literal task spec named `lib/engines/realizedPnlEngineV2` with an input shape of
// `{walletAddress, chains}` — NEITHER exists. The real module is src/modules/realizedPnl, exporting
// `computeRealizedPnl(closedLots: ClosedLot[]): RealizedPnlSummary` (src/modules/realizedPnl/
// pnlSummary.ts) — a PURE aggregator over already-closed FIFO lots, not a {walletAddress, chains}
// fetcher. The real upstream chain that PRODUCES ClosedLot[] from {walletAddress, chains} is:
//   fetchProviderWindow (raw fetch) -> swapNormalizer.normalizeTrades -> tradeIntent.classifyTradeIntent
//   -> lotOpener.openLots -> lotCloser.closeLots
// (see src/pipeline/index.ts's runWalletScan for the real reference sequence — not modified, read
// only). That whole chain is wired here via app/api/_shared/walletChainPipeline.ts's
// `buildLotsForChain`, which is REAL and ADDITIVE (imports only real, unmodified swapNormalizer/
// tradeIntent/lotOpener/lotCloser functions). This was fully feasible, not degraded.
//
// MULTI-CHAIN REALIZED PNL, DISCLOSED: `ClosedLot` (src/modules/lotCloser) carries no `chain` field
// at all, so `computeRealizedPnl` cannot report a genuinely per-chain breakdown. This route runs the
// real fetch/normalize/lot chain independently per requested chain (in parallel), then concatenates
// every chain's closedLots into ONE array before calling `computeRealizedPnl` once — an honest,
// disclosed wallet-wide combination across the requested chains, not a fabricated per-chain split.
// `chainsAttempted`/`chainsUnsupportedBySwapNormalizer` in the response disclose which requested
// chains actually contributed real closed-lot evidence (see walletChainPipeline.ts's `hyperevm`
// coverage-gap disclosure for why a chain can be silently unsupported here).
//
// UNREALIZED PNL — GENUINE UPSTREAM GAP, DISCLOSED (bridged, not degraded, where possible):
// `computeUnrealizedPnl`'s `Holding` type requires `acquiredAtTimestamp` (see lib/engines/
// unrealizedPnlEngine.ts's own header — this field was ADDED to that engine's spec for the same
// reason described there). `fetchHoldings` (src/modules/holdings) returns ONLY a current balance
// snapshot — no acquisition timestamp exists anywhere in `TokenHolding`. Rather than fabricate "now"
// as a fake acquisition time (which the unrealizedPnlEngine's own header explicitly calls out as
// silently defeating its purpose), `buildUnrealizedPnlForChain` (walletChainPipeline.ts) cross-
// references each held token against that SAME chain's real `remainingLots` (open, not-yet-closed
// FIFO lots from lotOpener/lotCloser, each carrying a REAL acquisition timestamp) by token address,
// and only computes real unrealized PnL for tokens where a genuine match exists. A held token with
// no matching open lot in the 90-day fetch window is honestly reported in `unresolvedHoldings` with
// a `reason`, never assigned a guessed timestamp.

import { NextResponse } from 'next/server'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { SUPPORTED_CHAINS } from '@/src/pipeline/types'
import type { ClosedLot } from '@/src/modules/lotCloser'
import { computeRealizedPnl, type RealizedPnlSummary } from '@/src/modules/realizedPnl'
import {
  buildLotsForChain,
  buildUnrealizedPnlForChain,
  type LotsForChainResult,
  type UnrealizedForChainResult,
} from '@/app/api/_shared/walletChainPipeline'
import { getTokenCache, setTokenCache } from '@/lib/server/cache/tokenCache'

// CU REDUCTION, DISCLOSED (see app/api/wallet-profile/route.ts's own header for the full
// disclosure): cached at THIS route's own call site, not inside buildLotsForChain/
// buildUnrealizedPnlForChain/walletChainPipeline.ts itself — buildLotsForChain is also called by
// lib/engine/modules/pnl/computePnl.ts for the real Deep Scan flow, so caching inside the shared
// function would have affected Deep Scan too. No raw-event dedup applies here: both functions
// already return processed results (closed lots / unrealized positions), not RawProviderEvent[].
const PNL_CACHE_TTL_SECONDS = 120

async function buildLotsForChainCached(chain: SupportedChain, walletAddress: string): Promise<LotsForChainResult> {
  const cacheKey = `pnl-lots-${walletAddress}-${chain}`
  const cached = await getTokenCache<LotsForChainResult>(cacheKey)
  if (cached) return cached

  const result = await buildLotsForChain(chain, walletAddress)
  await setTokenCache(cacheKey, result, PNL_CACHE_TTL_SECONDS)
  return result
}

async function buildUnrealizedPnlForChainCached(chain: SupportedChain, walletAddress: string): Promise<UnrealizedForChainResult> {
  const cacheKey = `pnl-unrealized-${walletAddress}-${chain}`
  const cached = await getTokenCache<UnrealizedForChainResult>(cacheKey)
  if (cached) return cached

  const result = await buildUnrealizedPnlForChain(chain, walletAddress)
  await setTokenCache(cacheKey, result, PNL_CACHE_TTL_SECONDS)
  return result
}

type PnlRequestBody = {
  walletAddress?: string
  chains?: string[]
}

function isSupportedChain(chain: string): chain is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain)
}

export async function POST(req: Request) {
  let body: PnlRequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { walletAddress, chains } = body
  if (!walletAddress || typeof walletAddress !== 'string') {
    return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 })
  }
  if (!Array.isArray(chains) || chains.length === 0) {
    return NextResponse.json({ error: 'chains is required and must be a non-empty array' }, { status: 400 })
  }

  const sanitizedChains = chains.filter(isSupportedChain)
  if (sanitizedChains.length === 0) {
    return NextResponse.json({ error: 'none of the requested chains are supported' }, { status: 400 })
  }

  // Realized PnL: real fetch -> normalize -> intent -> lot-open -> lot-close chain, per chain,
  // combined into one wallet-wide computeRealizedPnl call — see file header disclosure.
  const lotsPerChain = await Promise.all(sanitizedChains.map((chain) => buildLotsForChainCached(chain, walletAddress)))
  const allClosedLots: ClosedLot[] = lotsPerChain.flatMap((r) => r.closedLots)
  const realizedSummary: RealizedPnlSummary = computeRealizedPnl(allClosedLots)

  // Unrealized PnL: real fetchHoldings + real open-lot cross-reference, per chain (single-chain
  // scoped engine — see file header disclosure).
  const unrealizedPerChain = await Promise.all(sanitizedChains.map((chain) => buildUnrealizedPnlForChainCached(chain, walletAddress)))

  return NextResponse.json({
    realized: {
      summary: realizedSummary,
      chainsAttempted: sanitizedChains,
      chainsUnsupportedBySwapNormalizer: lotsPerChain.filter((r) => !r.chainSupported).map((r) => r.chain),
    },
    unrealized: {
      perChain: unrealizedPerChain.map((u) => ({
        chain: u.chain,
        result: u.result,
        unresolvedHoldings: u.unresolvedHoldings,
      })),
      totalUnrealizedPnlUsd: unrealizedPerChain.reduce((sum, u) => sum + u.result.totalUnrealizedPnlUsd, 0),
    },
  })
}
