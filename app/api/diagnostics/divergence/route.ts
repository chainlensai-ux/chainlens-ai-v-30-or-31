// GET /api/diagnostics/divergence — read the stored engine-comparison divergence log (see
// lib/server/engineComparison.ts / lib/server/divergenceStore.ts). Read-only, diagnostic-only:
// never triggers a scan, never calls a provider, never changes any stored state.
//
// GATING, DISCLOSED: same convention as this repo's other diagnostic routes
// (app/api/debug-engines, app/api/diagnostics/pricing, app/api/cu-usage, app/api/cu-diagnostics) —
// disabled in production unless an admin secret is presented, since this returns real wallet
// addresses alongside internal divergence data.

import { getDivergenceLog, type DivergenceEntry } from '@/lib/server/divergenceStore'

function isAuthorized(req: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  return Boolean(process.env.ADMIN_SECRET) && token === process.env.ADMIN_SECRET
}

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ success: false, error: 'Not available in production' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const url = new URL(req.url)
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 200))

  const all = await getDivergenceLog()
  const entries = all.slice(-limit)

  const byType: { pricing: DivergenceEntry[]; fifo: DivergenceEntry[] } = { pricing: [], fifo: [] }
  const byWallet: Record<string, DivergenceEntry[]> = {}

  for (const entry of entries) {
    byType[entry.type].push(entry)
    const key = entry.walletAddress.toLowerCase()
    if (!byWallet[key]) byWallet[key] = []
    byWallet[key].push(entry)
  }

  return Response.json({
    success: true,
    totalStored: all.length,
    returned: entries.length,
    entries,
    byType,
    byWallet,
  })
}
