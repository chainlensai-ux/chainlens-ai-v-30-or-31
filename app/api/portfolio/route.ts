import { NextResponse } from 'next/server'
import { fetchWalletSnapshot, type WalletSnapshotOptions } from '@/lib/server/walletSnapshot'

const PORTFOLIO_CACHE_TTL_MS = 3 * 60 * 1000
const portfolioCache = new Map<string, { exp: number; payload: unknown }>()
const portfolioRate = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_PER_MIN = 12
const SNAPSHOT_TIMEOUT_MS = 12_000

function ipOf(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

export async function POST(req: Request) {
  try {
    const ip = ipOf(req)
    const now = Date.now()
    const cur = portfolioRate.get(ip)
    if (!cur || cur.resetAt <= now) {
      portfolioRate.set(ip, { count: 1, resetAt: now + 60_000 })
    } else {
      if (cur.count >= RATE_LIMIT_PER_MIN) {
        return NextResponse.json({ error: 'Too many portfolio scans. Please try again shortly.' }, { status: 429 })
      }
      cur.count += 1
    }

    const body = await req.json() as { address?: string; refresh?: boolean }
    const url = new URL(req.url)
    const debug = url.searchParams.get('debug') === 'true'
    const address = String(body.address ?? '').trim().toLowerCase()
    if (!address) return NextResponse.json({ error: 'Wallet address required.' }, { status: 400 })
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return NextResponse.json({ error: 'Invalid wallet address.' }, { status: 400 })
    const refresh = body.refresh === true
    const cached = refresh ? null : portfolioCache.get(address)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.payload)
    const snapshot = await Promise.race([
      fetchWalletSnapshot(address, { refresh } satisfies WalletSnapshotOptions),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), SNAPSHOT_TIMEOUT_MS)),
    ])
    const providerFallback = (snapshot as any)._diagnostics?.providerFallback ?? null
    const payload: Record<string, unknown> = {
      address: snapshot.address,
      holdings: snapshot.holdings,
      totalValue: snapshot.totalValue,
      txCount: snapshot.txCount,
      behaviorChain: snapshot.behaviorChain,
      walletBehavior: snapshot.walletBehavior,
      estimatedPnl: snapshot.estimatedPnl,
      dataFreshness: snapshot.dataFreshness ?? 'live',
      cacheAgeSeconds: snapshot.cacheAgeSeconds ?? null,
      ...(debug ? { _debug: { providerFallback } } : {}),
    }
    if (!refresh) portfolioCache.set(address, { exp: Date.now() + PORTFOLIO_CACHE_TTL_MS, payload })
    return NextResponse.json(payload)
  } catch {
    return NextResponse.json({ error: 'Portfolio data is currently unavailable.' }, { status: 200 })
  }
}
