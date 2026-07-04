// app/api/transactions/route.ts
//
// FABRICATED-SPEC DISCLOSURE: the literal spec's `src/modules/transferNormalizer` does not exist
// anywhere in this codebase (confirmed by repo-wide search before this file was written). The real
// module doing normalization here is src/modules/swapNormalizer, exporting `normalizeTrades` (NOT
// `normalizeSwaps`) which takes `RawTxBundle[]` (src/modules/swapNormalizer/types.ts) — not raw
// transfers/swaps directly. The RAW-DATA-FETCH GAP (no fetch step named in the literal spec, and
// swapNormalizer does zero provider calls itself) is bridged via app/api/_shared/
// walletChainPipeline.ts's `buildTradeTimelineForChain`, which chains the REAL fetchProviderWindow
// (src/modules/providerFetchWindow) -> groupRawEventsIntoTxBundles (new, pure reshaping helper, see
// that file's header) -> normalizeTrades (real swapNormalizer) -> classifyTradeIntent (real
// src/modules/tradeIntent) -> tradeWithIntentToTimelineInputs (new adapter, see that file's header
// for the full shape-mismatch disclosure between swapNormalizer's TradeWithIntent and
// tradeTimelineEngineV2's NormalizedTransfer/NormalizedSwap) -> buildTradeTimelineV2 (real
// lib/engines/tradeTimelineEngineV2) sequence — mirroring src/pipeline/index.ts's real
// fetch->normalize sequence, read only, never modified.
//
// CHAIN COVERAGE: see walletChainPipeline.ts's disclosure on 'hyperevm' not being representable in
// swapNormalizer's SwapNormalizerChain — that chain contributes zero transactions here, surfaced via
// `chainsUnsupported` in the response, never silently dropped without a trace.

import { NextResponse } from 'next/server'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { SUPPORTED_CHAINS } from '@/src/pipeline/types'
import { buildTradeTimelineForChain } from '@/app/api/_shared/walletChainPipeline'

type TransactionsRequestBody = {
  walletAddress?: string
  chains?: string[]
}

function isSupportedChain(chain: string): chain is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain)
}

export async function POST(req: Request) {
  let body: TransactionsRequestBody
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

  const perChain = await Promise.all(sanitizedChains.map((chain) => buildTradeTimelineForChain(chain, walletAddress)))

  const transactions = perChain.flatMap((r) => r.trades).sort((a, b) => a.timestamp - b.timestamp)

  return NextResponse.json({
    transactions,
    chainsAttempted: sanitizedChains,
    chainsUnsupported: perChain.filter((r) => !r.chainSupported).map((r) => r.chain),
  })
}
