// DEPLOYER-BALANCE ROUTE, DISCLOSED (Cluster Map deployer wallet detail fix, resolution step 5 —
// "use cheap current token balance call only if supported and budget-safe"). Mirrors
// app/api/solana-wallet-detail/route.ts's pattern: one cheap, rate-limited, read-only RPC call fired
// on a Cluster Map node click, never the full (expensive) Wallet Scanner pass. Does exactly ONE
// eth_call `balanceOf(address)` against the token contract, plus one `eth_getBalance` for the
// deployer's native balance — both plain read-only RPC calls, no indexing/paging/history scan.
// eth/base only, matching the chains /api/dev-wallet itself supports today.

import { NextResponse } from 'next/server'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })

type SupportedChain = 'base' | 'eth'

function resolveBaseRpcUrl(): string | null {
  const explicit = process.env.ALCHEMY_BASE_RPC_URL || process.env.BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY || process.env.ALCHEMY_API_KEY
  if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
  return null
}

function resolveEthRpcUrl(): string | null {
  const explicit = process.env.ALCHEMY_ETH_RPC_URL || process.env.ETH_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_ETHEREUM_KEY || process.env.ALCHEMY_ETH_KEY || process.env.ALCHEMY_API_KEY
  if (key) return `https://eth-mainnet.g.alchemy.com/v2/${key}`
  return null
}

function getRpcUrl(chain: SupportedChain): string | null {
  return chain === 'eth' ? resolveEthRpcUrl() : resolveBaseRpcUrl()
}

function isAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v)
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const json = await res.json()
    return typeof json?.result === 'string' ? json.result : null
  } catch {
    return null
  }
}

export async function GET(req: Request) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ ok: false, reason: 'rate_limited' }, { status: 429 })
  }
  const url = new URL(req.url)
  const chain = (url.searchParams.get('chain') ?? '').toLowerCase()
  const tokenAddress = url.searchParams.get('tokenAddress') ?? ''
  const walletAddress = url.searchParams.get('walletAddress') ?? ''

  if (chain !== 'eth' && chain !== 'base') {
    return NextResponse.json({ ok: false, reason: 'unsupported_chain' }, { status: 400 })
  }
  if (!isAddress(tokenAddress) || !isAddress(walletAddress)) {
    return NextResponse.json({ ok: false, reason: 'invalid_address' }, { status: 400 })
  }

  const rpcUrl = getRpcUrl(chain)
  if (!rpcUrl) {
    return NextResponse.json({ ok: false, reason: 'rpc_not_configured' }, { status: 400 })
  }

  // balanceOf(address) selector = 0x70a08231, left-padded 32-byte address argument.
  const balanceOfData = `0x70a08231000000000000000000000000${walletAddress.slice(2).toLowerCase()}`
  const [balanceHex, nativeHex] = await Promise.all([
    rpcCall(rpcUrl, 'eth_call', [{ to: tokenAddress, data: balanceOfData }, 'latest']),
    rpcCall(rpcUrl, 'eth_getBalance', [walletAddress, 'latest']),
  ])

  const tokenBalanceRaw = balanceHex ? BigInt(balanceHex).toString() : null
  const nativeBalanceEth = nativeHex ? Number(BigInt(nativeHex)) / 1e18 : null

  return NextResponse.json({
    ok: true,
    chain,
    tokenAddress,
    walletAddress,
    tokenBalanceRaw,
    tokenBalanceSucceeded: tokenBalanceRaw !== null,
    nativeBalance: nativeBalanceEth,
    nativeBalanceSucceeded: nativeBalanceEth !== null,
  })
}
