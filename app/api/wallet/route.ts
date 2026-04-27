import { NextResponse } from 'next/server'
import { fetchWalletSnapshot } from '@/lib/server/walletSnapshot'

export async function POST(req: Request) {
  try {
    const { address } = await req.json()
    const snapshot = await fetchWalletSnapshot(address ?? '')
    return NextResponse.json(snapshot)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Wallet scan failed'
    const status = msg === 'Invalid wallet address' ? 400 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
