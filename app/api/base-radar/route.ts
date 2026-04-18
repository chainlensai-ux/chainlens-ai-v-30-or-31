import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/proxy/dex`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 30 },
    })

    if (!res.ok) {
      return NextResponse.json(
        { error: `Proxy error: ${res.status}` },
        { status: 502 }
      )
    }

    const data = await res.json()
    const baseOnly = data.pairs?.filter((p: { chainId: string }) => p.chainId === 'base') || []

    return NextResponse.json({ chain: 'base', trending: baseOnly })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
