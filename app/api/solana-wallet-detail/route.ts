// SOLANA WALLET DETAIL ROUTE, DISCLOSED (Cluster Map "click a node" follow-up task). Powers the
// wallet detail panel opened by clicking a node in the Solana Cluster Map graph. Real, cheap
// Alchemy/Solana RPC reads only (getBalance + latest signature) — see
// lib/server/solana/walletDetailAnalyzer.ts for the full disclosure. Additive, new route — every
// existing route/response shape in this codebase is untouched.

import { NextResponse } from 'next/server'
import { isSolanaChainAvailable, getSolanaRpcUrl } from '@/lib/server/solanaChainConfig'
import { fetchSolanaWalletSnapshot } from '@/lib/server/solana/walletDetailAnalyzer'
import { isValidSolanaMintAddress } from '@/lib/solanaAddress'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'

// Per-IP throttle: each click on a Cluster Map node fires 2 RPC calls (getBalance + latest
// signature). Without this, a scripted client could cheaply burn the shared Alchemy quota — see
// docs/token-scanner-audit-solana-2026-08-22.md finding #5.
const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })

export async function POST(req: Request) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 })
  }
  if (!isSolanaChainAvailable()) {
    return NextResponse.json({ ok: false, error: 'Solana is not enabled.' }, { status: 400 })
  }
  const rpcUrl = getSolanaRpcUrl()
  if (!rpcUrl) {
    return NextResponse.json({ ok: false, error: 'Solana is not configured yet.' }, { status: 400 })
  }
  const body = await req.json().catch(() => null) as { address?: unknown } | null
  const address = typeof body?.address === 'string' ? body.address.trim() : ''
  // Reuses the same address-shape validator the mint-scan path already trusts — a wallet address
  // and a mint address share the same base58/32-byte shape on Solana, so this is real validation,
  // not a new heuristic.
  if (!isValidSolanaMintAddress(address)) {
    return NextResponse.json({ ok: false, error: 'Invalid Solana address.' }, { status: 400 })
  }

  const snapshot = await fetchSolanaWalletSnapshot(address, rpcUrl, fetch)
  return NextResponse.json({ ok: true, snapshot })
}
