import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

type TokenScanPayload = {
  priceChart?: { points?: unknown[]; timeframe?: string | null } | null
  chartSource?: string | null
  chartStatus?: string | null
  chartReason?: string | null
  error?: string
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const address = url.searchParams.get('address') ?? url.searchParams.get('contract') ?? ''
  const chain = url.searchParams.get('chain') ?? 'base'

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid or missing address parameter.' }, { status: 400 })
  }

  const tokenUrl = new URL('/api/token', url.origin)
  tokenUrl.searchParams.set('contract', address)
  tokenUrl.searchParams.set('chain', chain)

  const res = await fetch(tokenUrl, {
    cache: 'no-store',
    headers: { authorization: req.headers.get('authorization') ?? '' },
  })
  const json = await res.json().catch(() => ({})) as TokenScanPayload
  if (!res.ok || json.error) {
    return NextResponse.json({ error: json.error ?? 'OHLCV data unavailable.' }, { status: res.ok ? 502 : res.status })
  }

  return NextResponse.json({
    points: json.priceChart?.points ?? [],
    timeframe: json.priceChart?.timeframe ?? '24h',
    source: json.chartSource ?? 'token_scanner_chart_pipeline',
    status: json.chartStatus ?? 'partial',
    reason: json.chartReason ?? null,
  })
}
