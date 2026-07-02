// GET /api/pricing/coingecko?token=<address>&chain=<eth|base|arbitrum|hyperevm>&timestamp=<ms>
//
// Thin HTTP wrapper around the existing fetchCoingeckoPrice() module function
// (src/modules/pricingAtTimeEngine/sources/coingecko.ts) — new route, no existing file modified.
//
// NAME CORRECTION, DISCLOSED: requested as wiring to `fetchCoingeckoHistoricalPrice()`, which does
// not exist anywhere in this codebase. The real export is `fetchCoingeckoPrice(token, chain,
// timestamp)` — wired to that instead.
//
// Same conventions as app/api/pricing/dexscreener/route.ts: NextResponse.json(), Cache-Control:
// no-store, export const dynamic = 'force-dynamic'. `data` is honestly null whenever CoinGecko has
// no real price for this token/timestamp — never fabricated.

import { NextResponse } from 'next/server'
import { fetchCoingeckoPrice } from '@/src/modules/pricingAtTimeEngine/sources/coingecko'
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
    const data = await fetchCoingeckoPrice(token, chain as SupportedChain, timestamp)

    return jsonNoStore({ ok: true, source: 'coingecko', data }, 200)
  } catch (err) {
    return jsonNoStore({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 500)
  }
}
