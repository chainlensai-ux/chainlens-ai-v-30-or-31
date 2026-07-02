// GET /api/test/zerion — minimal real connectivity check for the Zerion provider.
//
// testZerion() did not exist anywhere in this codebase — this is a new, thin wrapper (as
// instructed when the named function doesn't already exist). Zerion IS a real, already-integrated
// provider (lib/server/walletSnapshot.ts's zerionGet()/zerionAuth(), used by the wallet-scan
// pipeline) — this route mirrors that file's real base URL and auth scheme
// (https://api.zerion.io/v1/..., Basic base64(ZERION_KEY:)) rather than inventing a new one, and
// calls GET /v1/chains/ — a real, documented, lightweight endpoint that needs no wallet address.
//
// Same conventions as the pricing routes: NextResponse.json(), Cache-Control: no-store,
// export const dynamic = 'force-dynamic'.

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

function jsonNoStore(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function testZerion(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const key = process.env.ZERION_KEY
  if (!key) return { ok: false, error: 'no_api_key_configured' }

  try {
    const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`
    const res = await fetch('https://api.zerion.io/v1/chains/', {
      headers: { Accept: 'application/json', Authorization: auth },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { ok: false, error: `zerion_http_${res.status}` }
    const data = await res.json()
    return { ok: true, data: { chainCount: Array.isArray(data?.data) ? data.data.length : null } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
}

export async function GET() {
  const result = await testZerion()
  return result.ok ? jsonNoStore({ ok: true, data: result.data }, 200) : jsonNoStore({ ok: false, error: result.error }, 500)
}
