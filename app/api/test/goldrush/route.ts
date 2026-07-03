// GET /api/test/goldrush — minimal real connectivity check for the GoldRush/Covalent provider.
//
// testGoldrush() did not exist anywhere in this codebase — this is a new, thin wrapper (as
// instructed when the named function doesn't already exist). Uses the real, already-installed
// @covalenthq/client-sdk (the same SDK src/modules/pricingAtTimeEngine/sources/
// goldrushPriceSource.ts uses for real pricing) and calls BaseService.getAllChains() — a real,
// lightweight, documented SDK method that needs no wallet/token address, just a valid key.
//
// Same conventions as the pricing routes: NextResponse.json(), Cache-Control: no-store,
// export const dynamic = 'force-dynamic'.

import { NextResponse } from 'next/server'
import { GoldRushClient } from '@covalenthq/client-sdk'
import { logRpcCall } from '@/lib/server/rpcDebug'

export const dynamic = 'force-dynamic'

function jsonNoStore(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function testGoldrush(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
  if (!apiKey) return { ok: false, error: 'no_api_key_configured' }

  try {
    const client = new GoldRushClient(apiKey)
    logRpcCall({ route: '/api/test/goldrush', chain: 'all', method: 'goldrush_sdk_getAllChains' })
    const response = await client.BaseService.getAllChains()
    if (response.error) return { ok: false, error: response.error_message ?? 'goldrush_api_error' }
    return { ok: true, data: { chainCount: response.data?.items?.length ?? 0 } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
}

export async function GET() {
  const result = await testGoldrush()
  return result.ok ? jsonNoStore({ ok: true, data: result.data }, 200) : jsonNoStore({ ok: false, error: result.error }, 500)
}
