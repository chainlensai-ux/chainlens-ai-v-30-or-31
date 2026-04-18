import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/pairs/base', {
      headers: { Accept: 'application/json' },
      next: { revalidate: 30 },
    })

    if (!res.ok) {
      return NextResponse.json(
        { error: `DexScreener error: ${res.status}` },
        { status: 502 }
      )
    }

    const data = await res.json()
    const baseOnly = data.pairs?.filter(
      (p: { chainId: string }) => p.chainId === 'base'
    ) || []

    return NextResponse.json({ chain: 'base', trending: baseOnly })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
