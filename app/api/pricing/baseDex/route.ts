// GET /api/pricing/baseDex?token=<address>&chain=base&timestamp=<ms>
//
// Thin HTTP wrapper around the existing fetchBaseDexPrice() module function
// (src/modules/pricingAtTimeEngine/sources/basedex.ts) — new route, no existing file modified.
//
// basedex.ts's own header explains this is a real on-chain Uniswap V3 pool query via viem, not a
// call to any hosted "BaseDex API" (no such service exists) — see that file for the full note.
// `chain` is still accepted/validated as a query param for consistency with the sibling routes,
// but fetchBaseDexPrice() itself only ever answers for chain === 'base' (honest null otherwise).
//
// Same conventions as app/api/pricing/dexscreener/route.ts: NextResponse.json(), Cache-Control:
// no-store, export const dynamic = 'force-dynamic'. `data` is honestly null whenever no Uniswap V3
// pool/price can be resolved — never fabricated.

import { NextResponse } from 'next/server'
import { fetchBaseDexPrice } from '@/src/modules/pricingAtTimeEngine/sources/basedex'
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
    const data = await fetchBaseDexPrice(token, chain as SupportedChain, timestamp)

    return jsonNoStore({ ok: true, source: 'base_dex', data }, 200)
  } catch (err) {
    return jsonNoStore({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 500)
  }
}
