// GET /api/pricing/atTime?token=<address>&chain=<eth|base|arbitrum|hyperevm>&timestamp=<ms>
//
// Thin HTTP wrapper around the existing getPriceAtTime() orchestrator
// (src/modules/pricingAtTimeEngine/sources/multiProviderPriceSource.ts) — new route, no existing
// file modified.
//
// NAME CORRECTION, DISCLOSED: requested as wiring to `resolvePriceAtTime()`, which does not exist.
// Two real candidates exist: resolvePricingAtTime() (src/modules/pricingAtTimeEngine/index.ts) —
// takes batched buyEntries/sellEntries arrays, an incompatible shape for a single
// token/chain/timestamp query-param route — and getPriceAtTime({chain, tokenAddress, timestamp})
// — a single-lookup call matching this route's (and its three sibling routes') token/chain/
// timestamp convention exactly. Wired to getPriceAtTime().
//
// Unlike the sibling routes, getPriceAtTime() already returns a richer
// {priceUsd, source, debug} result (it's the real DexScreener -> CoinGecko -> Base-native DEX
// orchestrator) — `source` in the response below is that real, dynamic value (whichever provider
// actually answered, or 'none'), not a hardcoded string, and `data` includes the real per-provider
// debug attempts alongside priceUsd.
//
// Same conventions as app/api/pricing/dexscreener/route.ts: NextResponse.json(), Cache-Control:
// no-store, export const dynamic = 'force-dynamic'. priceUsd is honestly null whenever no provider
// can answer — never fabricated.

import { NextResponse } from 'next/server'
import { getPriceAtTime } from '@/src/modules/pricingAtTimeEngine/sources/multiProviderPriceSource'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'

export const dynamic = 'force-dynamic'

const SUPPORTED_CHAINS: SupportedChain[] = ['eth', 'base', 'arbitrum', 'hyperevm']

function jsonNoStore(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const token = searchParams.get('token')
    const chain = searchParams.get('chain')
    const timestampRaw = searchParams.get('timestamp')

    if (!token) {
      return jsonNoStore({ ok: false, error: 'missing required query param: token' }, 400)
    }
    if (!chain || !SUPPORTED_CHAINS.includes(chain as SupportedChain)) {
      return jsonNoStore(
        { ok: false, error: `missing or invalid required query param: chain (must be one of ${SUPPORTED_CHAINS.join(', ')})` },
        400,
      )
    }
    if (!timestampRaw || !Number.isFinite(Number(timestampRaw))) {
      return jsonNoStore({ ok: false, error: 'missing or invalid required query param: timestamp (must be a numeric ms epoch)' }, 400)
    }

    const timestamp = Number(timestampRaw)
    const result = await getPriceAtTime({ tokenAddress: token, chain: chain as SupportedChain, timestamp })

    return jsonNoStore({ ok: true, source: result.source, data: { priceUsd: result.priceUsd, debug: result.debug } }, 200)
  } catch (err) {
    return jsonNoStore({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 500)
  }
}
