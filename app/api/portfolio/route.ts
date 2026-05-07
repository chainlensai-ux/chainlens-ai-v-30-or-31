import { NextResponse } from 'next/server'
import { fetchWalletSnapshot } from '@/lib/server/walletSnapshot'

const PORTFOLIO_CACHE_TTL_MS = 3 * 60 * 1000
const portfolioCache = new Map<string, { exp: number; payload: unknown }>()

export async function POST(req: Request) {
  try {
    const body = await req.json() as { address?: string }
    const address = String(body.address ?? '').trim().toLowerCase()
    if (!address) return NextResponse.json({ error: 'Wallet address required.' }, { status: 400 })
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return NextResponse.json({ error: 'Invalid wallet address.' }, { status: 400 })
    const cached = portfolioCache.get(address)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.payload)
    const snapshot = await fetchWalletSnapshot(address)
    const payload = {
      address: snapshot.address,
      holdings: snapshot.holdings,
      totalValue: snapshot.totalValue,
      txCount: snapshot.txCount,
      behaviorChain: snapshot.behaviorChain,
      walletBehavior: snapshot.walletBehavior,
      estimatedPnl: snapshot.estimatedPnl,
    }
    portfolioCache.set(address, { exp: Date.now() + PORTFOLIO_CACHE_TTL_MS, payload })
    return NextResponse.json(payload)
  } catch {
    return NextResponse.json({ error: 'Portfolio data is currently unavailable.' }, { status: 200 })
  }
}
