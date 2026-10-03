// Backward-compatible endpoint, used lazily by any selected EVM cluster wallet.
// At most balanceOf + native balance; no indexer calls or scan-time fanout.
import { NextResponse } from 'next/server'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { readWalletBalance, walletDetailChain } from '@/lib/server/walletDetailBalance'

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })
export async function GET(req: Request) {
  if (!limiter.check(getClientIp(req))) return NextResponse.json({ ok: false, reason: 'rate_limited' }, { status: 429 })
  const url = new URL(req.url)
  const chain = (url.searchParams.get('chain') ?? '').toLowerCase()
  const tokenAddress = url.searchParams.get('tokenAddress') ?? ''
  const walletAddress = url.searchParams.get('walletAddress') ?? ''
  const config = walletDetailChain(chain)
  if (!config) return NextResponse.json({ ok: false, reason: 'unsupported_chain' }, { status: 400 })
  if (![tokenAddress, walletAddress].every(v => /^0x[a-fA-F0-9]{40}$/.test(v))) return NextResponse.json({ ok: false, reason: 'invalid_address' }, { status: 400 })
  if (!config.rpcUrl) return NextResponse.json({ ok: false, reason: 'rpc_not_configured' }, { status: 400 })
  const snapshot = await readWalletBalance({ ...config, rpcUrl: config.rpcUrl }, tokenAddress, walletAddress)
  return NextResponse.json({ ok: true, chain, tokenAddress, walletAddress, ...snapshot }, { headers: { 'Cache-Control': 'private, no-store' } })
}
