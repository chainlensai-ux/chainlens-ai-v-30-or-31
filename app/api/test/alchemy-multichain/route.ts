// GET /api/test/alchemy-multichain?chain=base|mainnet|polygon|arbitrum
//
// NEW route, deliberately NOT at app/api/test/alchemy/route.ts — that file already exists as real,
// pre-existing production code (admin-gated behind ADMIN_SECRET in production, rate-limited,
// hardcoded to Ethereum via ALCHEMY_ETHEREUM_KEY) and was left untouched per "do not modify any
// existing production files." This route implements the requested multi-chain diagnostic
// separately instead of overwriting it.
//
// KEY-SELECTION CORRECTION, DISCLOSED: requested as always reading process.env.ALCHEMY_BASE_KEY
// regardless of chain — that would silently use the Base API key against Ethereum/Polygon/
// Arbitrum endpoints, which doesn't work (Alchemy keys are per-network in this codebase's existing
// convention: ALCHEMY_ETHEREUM_KEY, ALCHEMY_BASE_KEY, ALCHEMY_POLYGON_KEY, ALCHEMY_ARBITRUM_KEY —
// see .env.example / lib/rpc.ts / src/modules/providerFetchWindow/utils.ts's
// ALCHEMY_VERIFIED_CHAINS). Selects the correct key per requested chain instead.
//
// Real Alchemy network slugs, matching this codebase's existing
// src/modules/providerFetchWindow/utils.ts ALCHEMY_VERIFIED_CHAINS map (base/eth/arbitrum) plus
// polygon (explicitly requested, and ALCHEMY_POLYGON_KEY already exists in .env.example).
//
// Same conventions as the other test routes: NextResponse.json(), Cache-Control: no-store,
// export const dynamic = 'force-dynamic'.

import { NextResponse } from 'next/server'
import { logRpcCall } from '@/lib/server/rpcDebug'

export const dynamic = 'force-dynamic'

const CHAIN_CONFIG: Record<string, { networkSlug: string; envKey: string }> = {
  base: { networkSlug: 'base-mainnet', envKey: 'ALCHEMY_BASE_KEY' },
  mainnet: { networkSlug: 'eth-mainnet', envKey: 'ALCHEMY_ETHEREUM_KEY' },
  polygon: { networkSlug: 'polygon-mainnet', envKey: 'ALCHEMY_POLYGON_KEY' },
  arbitrum: { networkSlug: 'arb-mainnet', envKey: 'ALCHEMY_ARBITRUM_KEY' },
}

function jsonNoStore(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const chain = searchParams.get('chain') ?? 'base'

    const config = CHAIN_CONFIG[chain]
    if (!config) {
      return jsonNoStore(
        { ok: false, error: `invalid chain (must be one of ${Object.keys(CHAIN_CONFIG).join(', ')})` },
        400,
      )
    }

    const key = process.env[config.envKey]
    if (!key) {
      return jsonNoStore({ ok: false, error: 'no_api_key_configured' }, 500)
    }

    const url = `https://${config.networkSlug}.g.alchemy.com/v2/${key}`
    logRpcCall({ route: '/api/test/alchemy-multichain', chain, method: 'eth_blockNumber' })
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(8_000),
    })

    if (!res.ok) {
      return jsonNoStore({ ok: false, error: `alchemy_http_${res.status}` }, 502)
    }

    const data = await res.json()
    return jsonNoStore({ ok: true, data }, 200)
  } catch (err) {
    return jsonNoStore({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 500)
  }
}
