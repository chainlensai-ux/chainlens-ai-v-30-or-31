// GET /api/test/alchemy-multichain?chain=base|mainnet|polygon|arbitrum
//
// NEW route, deliberately NOT at app/api/test/alchemy/route.ts — that file already exists as real,
// pre-existing production code (admin-gated behind ADMIN_SECRET in production, rate-limited,
// hardcoded to Ethereum via ALCHEMY_ETHEREUM_KEY) and was left untouched per "do not modify any
// existing production files." This route implements the requested multi-chain diagnostic
// separately instead of overwriting it.
//
// CU-LEAK AUDIT FIX, DISCLOSED (found live: this route shipped with NEITHER the production admin
// gate NOR the rate limit its own sibling /api/test/alchemy/route.ts already has — a real, public,
// unauthenticated GET endpoint making a real Alchemy call across 4 chains, discoverable at a
// predictable /api/test/* path bots/scanners specifically probe for. Every real
// eth_blockNumber call it makes is cheap in isolation, but with zero auth and zero rate limit any
// repeated/automated hits accumulate for free, unbounded, forever).
//
// HARDENED FURTHER, DISCLOSED (follow-up task): the first fix still allowed a production bypass via
// x-admin-secret. Per explicit instruction, this route (and every other /api/test/* route that can
// call a paid provider) now ALWAYS returns 404 in production with ZERO exception — it makes zero
// provider calls there even with the correct admin secret. Usable only in local development
// (see lib/server/devOnlyProviderRoute.ts). The per-IP rate limit is kept for local-dev safety but
// is no longer what protects production — production protection is now unconditional.
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
import { auditGlobalAlchemyCall } from '@/lib/server/globalRpcAudit'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { isDevOnlyProviderRouteAllowed, devOnlyProviderRouteBlockedResponse } from '@/lib/server/devOnlyProviderRoute'
import { recordAlchemyUsage } from '@/lib/server/alchemyUsageAttribution'
import { estimatedCuForMethod } from '@/lib/server/alchemyCallBudget'

export const dynamic = 'force-dynamic'

const CHAIN_CONFIG: Record<string, { networkSlug: string; envKey: string }> = {
  base: { networkSlug: 'base-mainnet', envKey: 'ALCHEMY_BASE_KEY' },
  mainnet: { networkSlug: 'eth-mainnet', envKey: 'ALCHEMY_ETHEREUM_KEY' },
  polygon: { networkSlug: 'polygon-mainnet', envKey: 'ALCHEMY_POLYGON_KEY' },
  arbitrum: { networkSlug: 'arb-mainnet', envKey: 'ALCHEMY_ARBITRUM_KEY' },
}

// Same limiter shape/window as the sibling /api/test/alchemy/route.ts (3/minute per IP) — this
// route is strictly more expensive per hit (up to 4 real chain calls behind one request via the
// `chain` param, though only one is issued per actual call) so it gets the same discipline, never
// a looser one.
const limiter = createRateLimiter({ windowMs: 60_000, max: 3 })

function jsonNoStore(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: Request) {
  try {
    // CU-LEAK AUDIT HARDENING, DISCLOSED (this task): ALWAYS blocked in production now — no
    // ADMIN_SECRET bypass. A bypass, however gated, is still a live path to a real Alchemy call in
    // production, across 4 chains; this route is now local-development-only, zero exception, zero
    // provider call ever reachable in production.
    if (!isDevOnlyProviderRouteAllowed()) {
      return devOnlyProviderRouteBlockedResponse()
    }
    const ip = getClientIp(req)
    if (!limiter.check(ip)) {
      return jsonNoStore({ error: 'Rate limited' }, 429)
    }

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
    auditGlobalAlchemyCall('eth_blockNumber', { chain, route: '/api/test/alchemy-multichain' })
    // USAGE ATTRIBUTION, DISCLOSED (this task) — see lib/server/alchemyUsageAttribution.ts's own
    // header: never logs the API key/wallet/token contents, only the shape of the call itself.
    recordAlchemyUsage({
      requestId: crypto.randomUUID(),
      route: '/api/test/alchemy-multichain',
      feature: 'provider_connectivity_check',
      method: 'eth_blockNumber',
      chain,
      cacheHit: false,
      userClassification: 'anonymous',
      sourceCategory: 'admin',
      estimatedCu: estimatedCuForMethod('eth_blockNumber'),
    })
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
