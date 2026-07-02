// GET /api/pricing/dexscreener?token=<address>&chain=<eth|base|arbitrum|hyperevm>&timestamp=<ms>
//
// Thin HTTP wrapper around the existing fetchDexscreenerPrice() module function
// (src/modules/pricingAtTimeEngine/sources/dexscreener.ts) — new route, no existing file modified.
// fetchDexscreenerPrice() is itself honest: DexScreener's real public API only exposes CURRENT
// pair state (no historical OHLCV/candle endpoint), so it only returns a real price when
// `timestamp` is within ~5 minutes of "now" and otherwise returns null — this route passes that
// null straight through as `data: null`, never fabricating a price.
//
// `cache: "no-store"` isn't a real option on NextResponse.json() (that's a fetch() request option,
// not a Response one) — the real equivalent is a Cache-Control: no-store response header plus
// `export const dynamic = 'force-dynamic'`, both set below.

import { NextResponse } from 'next/server'
import { fetchDexscreenerPrice } from '@/src/modules/pricingAtTimeEngine/sources/dexscreener'
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
    const data = await fetchDexscreenerPrice(token, chain as SupportedChain, timestamp)

    return jsonNoStore({ ok: true, source: 'dexscreener', data }, 200)
  } catch (err) {
    return jsonNoStore({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 500)
  }
}
