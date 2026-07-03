// GET /api/test/covalent — minimal real connectivity check for the Covalent REST API.
//
// testCovalent() did not exist anywhere in this codebase — this is a new, thin wrapper (as
// instructed when the named function doesn't already exist). Covalent and GoldRush are the same
// company/product (this codebase already treats GOLDRUSH_API_KEY/COVALENT_API_KEY as
// interchangeable everywhere else — see src/pipeline/index.ts's buildPriceSources()), but this
// route hits the raw REST API directly (https://api.covalenthq.com/..., Bearer auth) rather than
// the @covalenthq/client-sdk wrapper the goldrush test route uses — mirroring the real pattern
// already in app/api/proxy/goldrush/route.ts, so the two test routes exercise genuinely different
// code paths (SDK vs. raw REST) instead of being pure duplicates of each other.
//
// Same conventions as the pricing routes: NextResponse.json(), Cache-Control: no-store,
// export const dynamic = 'force-dynamic'.

import { NextResponse } from 'next/server'
import { logRpcCall } from '@/lib/server/rpcDebug'

export const dynamic = 'force-dynamic'

function jsonNoStore(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function testCovalent(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const apiKey = process.env.COVALENT_API_KEY ?? process.env.GOLDRUSH_API_KEY
  if (!apiKey) return { ok: false, error: 'no_api_key_configured' }

  try {
    logRpcCall({ route: '/api/test/covalent', chain: 'all', method: 'covalent_chains' })
    const res = await fetch('https://api.covalenthq.com/v1/chains/', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { ok: false, error: `covalent_http_${res.status}` }
    const data = await res.json()
    return { ok: true, data: { chainCount: Array.isArray(data?.data?.items) ? data.data.items.length : null } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
}

export async function GET() {
  const result = await testCovalent()
  return result.ok ? jsonNoStore({ ok: true, data: result.data }, 200) : jsonNoStore({ ok: false, error: result.error }, 500)
}
